#!/usr/bin/env python3
"""Serve the model editor and optionally run a configured local WMC simulation."""

import argparse
import json
import math
import re
import secrets
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


APP_DIR = Path(__file__).resolve().parent
MAX_REQUEST_BYTES = 5 * 1024 * 1024
RUN_ID_PATTERN = re.compile(r"^[a-f0-9]{24}$")
ACTION_TYPES = {"DistributedWorkFunction", "SynchronyFunction"}
NODE_TYPES = ACTION_TYPES | {"BaseEnvironmentResource"}


class SimulationError(Exception):
    """An expected local simulation or setup failure."""


def load_simulation_config(config_path):
    try:
        raw_config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read WMC config {config_path}: {error}") from error
    if not isinstance(raw_config, dict):
        raise ValueError("The WMC config root must be an object.")

    required = ("wmc_dir", "nodes", "agents")
    missing = [key for key in required if key not in raw_config]
    if missing:
        raise ValueError(f"The WMC config is missing required fields: {', '.join(missing)}.")

    def resolve_path(value, field, base):
        if not isinstance(value, str) or not value:
            raise ValueError(f'WMC config "{field}" must be a non-empty path string.')
        path = Path(value).expanduser()
        return (base / path).resolve() if not path.is_absolute() else path.resolve()

    wmc_dir = resolve_path(raw_config["wmc_dir"], "wmc_dir", config_path.parent)
    executable = resolve_path(
        raw_config.get("executable", "build/CHIMP"), "executable", wmc_dir
    )
    runs_dir = resolve_path(
        raw_config.get("runs_dir", "Results/runs"), "runs_dir", wmc_dir
    )
    nodes = raw_config["nodes"]
    agents = raw_config["agents"]
    if not isinstance(nodes, dict) or any(
        not isinstance(node_id, str)
        or not node_id
        or not isinstance(node_type, str)
        or node_type not in NODE_TYPES
        for node_id, node_type in nodes.items()
    ):
        raise ValueError('WMC config "nodes" must map node IDs to supported WMC node types.')
    if not isinstance(agents, list) or any(
        not isinstance(agent, str) or not agent for agent in agents
    ) or len(agents) != len(set(agents)):
        raise ValueError('WMC config "agents" must be an array of unique, non-empty names.')

    def result_filename(field, default):
        filename = raw_config.get(field, default)
        if not isinstance(filename, str) or not filename or Path(filename).name != filename:
            raise ValueError(f'WMC config "{field}" must be a filename, not a path.')
        return filename

    trace_file = result_filename("trace_file", "actionTrace.json")
    metrics_file = result_filename("metrics_file", "metrics.json")
    if trace_file == metrics_file:
        raise ValueError('"trace_file" and "metrics_file" must be different filenames.')
    results_url = raw_config.get("results_url")
    if results_url is not None and (
        not isinstance(results_url, str) or "{runId}" not in results_url
    ):
        raise ValueError('WMC config "results_url" must be a URL template containing "{runId}".')

    return {
        "wmc_dir": wmc_dir,
        "executable": executable,
        "runs_dir": runs_dir,
        "nodes": nodes,
        "agents": set(agents),
        "trace_file": trace_file,
        "metrics_file": metrics_file,
        "results_url": results_url,
    }


def validate_model(value, config):
    if not isinstance(value, dict):
        raise ValueError("The JSON root must be an object.")
    graph = value.get("GraphData")
    if not isinstance(graph, dict):
        raise ValueError("The JSON must contain a GraphData object.")
    nodes = graph.get("Nodes")
    edges = graph.get("Edges")
    agents = graph.get("Agents")
    if not isinstance(nodes, dict):
        raise ValueError("GraphData.Nodes must be an object keyed by node ID.")
    if not isinstance(edges, list):
        raise ValueError("GraphData.Edges must be an array.")
    if not isinstance(agents, dict):
        raise ValueError("GraphData.Agents must be an object keyed by agent name.")

    for node_id, node in nodes.items():
        if node_id not in config["nodes"]:
            raise ValueError(
                f'WMC config does not define node "{node_id}". '
                "Add it to the config's nodes mapping to enable simulation."
            )
        expected_type = config["nodes"][node_id]
        if not isinstance(node, dict) or node.get("Type") != expected_type:
            raise ValueError(f'Node "{node_id}" must have type {expected_type}.')
        user_data = node.get("UserData")
        if not isinstance(user_data, dict):
            raise ValueError(f'Node "{node_id}" must have a UserData object.')
        duration = user_data.get("Duration")
        try:
            valid_duration = (
                type(duration) in (int, float)
                and math.isfinite(float(duration))
                and duration >= 0
            )
        except OverflowError:
            valid_duration = False
        if not valid_duration:
            raise ValueError(f'Node "{node_id}" must have a non-negative numeric Duration.')

    for index, edge in enumerate(edges, start=1):
        if not isinstance(edge, dict):
            raise ValueError(f"Edge {index} must be an object.")
        source = edge.get("Source")
        target = edge.get("Target")
        if not isinstance(source, str) or not isinstance(target, str) or source not in nodes or target not in nodes:
            raise ValueError(f"Edge {index} references a node that does not exist.")
        edge_data = edge.get("UserData")
        if not isinstance(edge_data, dict):
            raise ValueError(f"Edge {index} must have a UserData object.")
        qos = edge_data.get("QOS", "")
        if isinstance(qos, str):
            if qos and (
                not re.fullmatch(r"-?\d+", qos)
                or not -(2**31) <= int(qos) < 2**31
            ):
                raise ValueError(f"Edge {index} QOS must be blank or an integer.")
        elif type(qos) is not int or not -(2**31) <= qos < 2**31:
            raise ValueError(f"Edge {index} QOS must be blank or an integer.")

        source_type = nodes[source]["Type"]
        target_type = nodes[target]["Type"]
        valid_direction = (
            source_type in ACTION_TYPES and target_type == "BaseEnvironmentResource"
        ) or (
            source_type == "BaseEnvironmentResource" and target_type in ACTION_TYPES
        )
        if not valid_direction:
            raise ValueError(
                f"Edge {index} must connect a built-in action and a built-in resource."
            )

    for agent_name, agent in agents.items():
        if agent_name not in config["agents"]:
            raise ValueError(
                f'WMC config does not define agent "{agent_name}". '
                "Add it to the config's agents array to enable simulation."
            )
        if not isinstance(agent, dict) or not isinstance(agent.get("Authority"), list):
            raise ValueError(f'Agent "{agent_name}" must have an Authority array.')
        for action_id in agent["Authority"]:
            if (
                not isinstance(action_id, str)
                or action_id not in nodes
                or nodes[action_id]["Type"] not in ACTION_TYPES
            ):
                raise ValueError(
                    f'Agent "{agent_name}" has an unsupported action in Authority: "{action_id}".'
                )


def find_executable(config):
    executable = config["executable"]
    candidates = [executable]
    if executable == config["wmc_dir"] / "build" / "CHIMP":
        candidates.insert(0, config["wmc_dir"] / "build" / "Debug" / "CHIMP")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SimulationError(
        f"The WMC executable was not found at {executable}. "
        "Build WMC or set the executable path in the config."
    )


def run_simulation(value, config):
    executable = find_executable(config)
    run_id = secrets.token_hex(12)
    run_directory = config["runs_dir"] / run_id
    run_directory.mkdir(parents=True, exist_ok=False)
    model_path = run_directory / "model.json"
    model_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    try:
        completed = subprocess.run(
            [str(executable), str(model_path), str(run_directory)],
            cwd=config["wmc_dir"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
    except subprocess.TimeoutExpired as error:
        raise SimulationError("The WMC simulation exceeded the 120-second time limit.") from error
    except OSError as error:
        raise SimulationError(f"Could not start the WMC executable: {error}") from error

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout).strip()
        if not details:
            details = f"WMC exited with status {completed.returncode}."
        raise SimulationError(details[-4000:])

    try:
        trace = json.loads((run_directory / config["trace_file"]).read_text(encoding="utf-8"))
        metrics = json.loads((run_directory / config["metrics_file"]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SimulationError(f"WMC did not produce valid result files: {error}") from error
    if not isinstance(trace, list) or not trace:
        raise SimulationError(f'WMC produced an empty {config["trace_file"]}.')
    if not isinstance(metrics, list) or not metrics:
        raise SimulationError(f'WMC produced an empty {config["metrics_file"]}.')

    return {
        "runId": run_id,
        "eventCount": len(trace),
        "sampleCount": len(metrics),
    }


class RequestHandler(SimpleHTTPRequestHandler):
    simulation_config = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/runs":
            self.send_json(404, {"error": "Unknown API endpoint."})
            return
        if self.simulation_config is None:
            self.send_json(503, {"error": "WMC simulation is not configured. Start with --config."})
            return
        origin = self.headers.get("Origin")
        if origin and (
            urlsplit(origin).scheme != "http"
            or urlsplit(origin).netloc != self.headers.get("Host")
        ):
            self.send_json(403, {"error": "Cross-origin simulation requests are not allowed."})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Content-Type must be application/json."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(400, {"error": "A valid Content-Length header is required."})
            return
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "The model JSON must be at most 5 MiB."})
            return
        try:
            model = json.loads(self.rfile.read(content_length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": f"Invalid JSON: {error}"})
            return
        try:
            validate_model(model, self.simulation_config)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        try:
            result = run_simulation(model, self.simulation_config)
        except SimulationError as error:
            self.send_json(500, {"error": str(error)})
            return
        self.send_json(200, result)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/config":
            config = self.simulation_config
            self.send_json(200, {
                "simulationEnabled": config is not None,
                "resultsUrl": config["results_url"] if config else None,
            })
            return
        prefix = "/api/runs/"
        if not path.startswith(prefix):
            super().do_GET()
            return
        if self.simulation_config is None:
            self.send_json(503, {"error": "WMC simulation is not configured. Start with --config."})
            return
        run_id = path[len(prefix):]
        if not RUN_ID_PATTERN.fullmatch(run_id):
            self.send_json(400, {"error": "Invalid run ID."})
            return
        run_directory = self.simulation_config["runs_dir"] / run_id
        try:
            trace = json.loads(
                (run_directory / self.simulation_config["trace_file"]).read_text(encoding="utf-8")
            )
            metrics = json.loads(
                (run_directory / self.simulation_config["metrics_file"]).read_text(encoding="utf-8")
            )
        except FileNotFoundError:
            self.send_json(404, {"error": "Simulation results were not found."})
            return
        except json.JSONDecodeError as error:
            self.send_json(500, {"error": f"Stored simulation results are invalid: {error}"})
            return
        self.send_json(200, {"trace": trace, "metrics": metrics, "pressure": metrics})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000, help="localhost HTTP port (default: 8000)")
    parser.add_argument(
        "--config",
        type=Path,
        help="JSON file configuring the local WMC simulation (simulation is disabled without it)",
    )
    args = parser.parse_args()
    try:
        RequestHandler.simulation_config = (
            load_simulation_config(args.config.resolve()) if args.config else None
        )
    except ValueError as error:
        parser.error(str(error))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), RequestHandler)
    print(f"Model editor: http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local WMC runner.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
