# Model Editor

A browser-based editor for JSON graph models with `GraphData.Nodes`,
`GraphData.Edges`, and `GraphData.Agents`. Open a model with **Open JSON**, edit
it in the graph or full JSON editor, then use **Download JSON** to save it.
Graph operations support WMC work-function and resource types; other model
fields are preserved by the JSON editor. A generic example model is loaded on
startup and can be replaced with your own JSON.

Start the local server and open `http://127.0.0.1:8000/`:

```sh
python3 run_server.py
```

## Optional WMC simulation

`run_server.py` can also submit a model to a local WMC executable. The
simulation integration is disabled unless a configuration file is provided;
the editor itself remains usable without a WMC checkout.

Create a JSON config file (see [wmc-config.example.json](./wmc-config.example.json))
and customize it for your simulation:

```json
{
  "wmc_dir": "../path-to-wmc",
  "executable": "build/CHIMP",
  "runs_dir": "Results/runs",
  "nodes": {
    "WorkFunctionId": "DistributedWorkFunction",
    "ResourceId": "BaseEnvironmentResource"
  },
  "agents": ["AgentName"],
  "trace_file": "actionTrace.json",
  "metrics_file": "metrics.json"
}
```

The `nodes` mapping must list every node ID that the WMC build supports and
its WMC type. Valid types are `DistributedWorkFunction`,
`SynchronyFunction`, and `BaseEnvironmentResource`. `agents` lists the
supported agent names. These are configuration values rather than editor
code, so each host repository can maintain its own mapping.

Paths in the config are resolved relative to the config file, except
`executable` and `runs_dir`, which are resolved relative to `wmc_dir`.
`executable`, `runs_dir`, `trace_file`, and `metrics_file` are optional; their
defaults are shown above. For WMC builds that write `PressureDynamics.json`,
set `metrics_file` to that filename. The executable receives the model JSON
path and run directory as its two arguments. It must write non-empty JSON
arrays to the configured trace and metrics files. The results API returns
these as `trace` and `metrics`; it also includes a legacy `pressure` alias for
compatibility with the original results viewer. An optional `results_url`
config value can provide a URL template containing `{runId}` to show a results
link in the editor.

Start the local server with the config path:

```sh
python3 run_server.py --config /path/to/wmc-config.json
```

If this editor is a submodule, keep the config in the host repository and
point `wmc_dir` at that repository's WMC checkout. Relative paths in that file
are based on its location, so the submodule can be moved without changing the
simulation paths. The combined server serves this editor folder and binds only
to `127.0.0.1`.
