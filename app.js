const elements = {
    canvas: document.querySelector("#graph"),
    fileInput: document.querySelector("#file-input"),
    jsonEditor: document.querySelector("#json-editor"),
    status: document.querySelector("#status"),
    selection: document.querySelector("#selection"),
    addNode: document.querySelector("#add-node"),
    addAgent: document.querySelector("#add-agent"),
    addEdge: document.querySelector("#add-edge"),
    deleteSelected: document.querySelector("#delete-selected"),
    applyJson: document.querySelector("#apply-json"),
    formatJson: document.querySelector("#format-json"),
    openFile: document.querySelector("#open-file"),
    download: document.querySelector("#download"),
    runSimulation: document.querySelector("#run-simulation"),
    viewResults: document.querySelector("#view-results"),
    valueDialog: document.querySelector("#value-dialog"),
    valueForm: document.querySelector("#value-form"),
    valueDialogTitle: document.querySelector("#value-dialog-title"),
    valueLabel: document.querySelector("#value-label"),
    valueInput: document.querySelector("#value-input"),
    valueHelp: document.querySelector("#value-help"),
};

const modelUrl = "./example-model.json";
let model = null;
let cy = null;
let dragAndDrop = null;
let activeFileName = "example-model.json";
let saveDialogValue = null;
let simulationEnabled = false;
let resultsUrlTemplate = null;

function setStatus(message, state = "ready") {
    elements.status.textContent = message;
    elements.status.dataset.state = state;
}

function validateModel(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("The JSON root must be an object.");
    }
    const graph = value.GraphData;
    if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
        throw new Error("The JSON must contain a GraphData object.");
    }
    if (!graph.Nodes || typeof graph.Nodes !== "object" || Array.isArray(graph.Nodes)) {
        throw new Error("GraphData.Nodes must be an object keyed by node ID.");
    }
    if (!Array.isArray(graph.Edges)) {
        throw new Error("GraphData.Edges must be an array.");
    }
    if (!graph.Agents || typeof graph.Agents !== "object" || Array.isArray(graph.Agents)) {
        throw new Error("GraphData.Agents must be an object keyed by agent name.");
    }

    const nodeIds = new Set(Object.keys(graph.Nodes));
    for (const [index, edge] of graph.Edges.entries()) {
        if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
            throw new Error(`Edge ${index + 1} must be an object.`);
        }
        if (!nodeIds.has(edge.Source) || !nodeIds.has(edge.Target)) {
            throw new Error(`Edge ${index + 1} references a node that does not exist.`);
        }
    }
    for (const [agentName, agent] of Object.entries(graph.Agents)) {
        if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
            throw new Error(`Agent "${agentName}" must be an object.`);
        }
        if (!Array.isArray(agent.Authority)) {
            throw new Error(`Agent "${agentName}" must have an Authority array.`);
        }
        for (const nodeId of agent.Authority) {
            if (!nodeIds.has(nodeId)) {
                throw new Error(`Agent "${agentName}" has an unknown node in Authority: "${nodeId}".`);
            }
        }
    }
    return value;
}

function isWorkFunction(node) {
    return node.Type === "DistributedWorkFunction" || node.Type === "SynchronyFunction";
}

function syncEditor() {
    elements.jsonEditor.value = JSON.stringify(model, null, 2);
}

function openValueDialog({ title, label, value, help, min, max, step, required, save }) {
    elements.valueDialogTitle.textContent = title;
    elements.valueLabel.textContent = label;
    elements.valueInput.type = "number";
    elements.valueInput.value = value == null ? "" : String(value);
    elements.valueInput.min = min;
    elements.valueInput.max = max;
    elements.valueInput.step = step;
    elements.valueInput.required = required;
    elements.valueHelp.textContent = help;
    saveDialogValue = save;
    elements.valueDialog.showModal();
    elements.valueInput.focus();
    elements.valueInput.select();
}

function editDuration(nodeId) {
    const node = model.GraphData.Nodes[nodeId];
    openValueDialog({
        title: `Edit duration: ${nodeId}`,
        label: "Duration",
        value: node.UserData?.Duration,
        help: "Enter a non-negative number.",
        min: "0",
        max: "",
        step: "any",
        required: true,
        save(value) {
            const duration = Number(value);
            if (!value.trim() || !Number.isFinite(duration) || duration < 0) {
                throw new Error("Duration must be a non-negative number.");
            }
            if (!node.UserData || typeof node.UserData !== "object" || Array.isArray(node.UserData)) {
                node.UserData = {};
            }
            node.UserData.Duration = duration;
            syncEditor();
            setStatus(`Updated ${nodeId} duration`);
        }
    });
}

function editQos(edgeIndex) {
    const edge = model.GraphData.Edges[edgeIndex];
    const qos = edge.UserData?.QOS;
    openValueDialog({
        title: `Edit QoS: ${edge.Source} → ${edge.Target}`,
        label: "QoS",
        value: qos,
        help: "Leave blank or enter a 32-bit integer.",
        min: String(-(2 ** 31)),
        max: String(2 ** 31 - 1),
        step: "1",
        required: false,
        save(value) {
            const trimmed = value.trim();
            if (trimmed && (!/^-?\d+$/.test(trimmed) ||
                Number(trimmed) < -(2 ** 31) || Number(trimmed) > 2 ** 31 - 1)) {
                throw new Error("QoS must be blank or a 32-bit integer.");
            }
            if (!edge.UserData || typeof edge.UserData !== "object" || Array.isArray(edge.UserData)) {
                edge.UserData = {};
            }
            edge.UserData.QOS = typeof qos === "number" && trimmed ? Number(trimmed) : trimmed;
            syncEditor();
            setStatus(`Updated QoS for ${edge.Source} → ${edge.Target}`);
        }
    });
}

function refreshSelection() {
    if (!cy) return;
    const selected = cy.$(":selected");
    if (selected.length === 0) {
        elements.selection.textContent = "Select a node, edge, or agent in the graph.";
        return;
    }
    elements.selection.textContent = selected.map((element) => {
        if (element.isEdge()) {
            return `${element.data("sourceModelId")} → ${element.data("targetModelId")}`;
        }
        return element.data("modelId") || element.data("agentName");
    }).join(", ");
}

function renderGraph() {
    if (cy) {
        cy.destroy();
        cy = null;
        dragAndDrop = null;
    }

    const graph = model.GraphData;
    const nodeIds = new Map(Object.keys(graph.Nodes).map((id, index) => [id, `model-node-${index}`]));
    const agentIds = new Map(Object.keys(graph.Agents).map((name, index) => [name, `model-agent-${index}`]));
    const nodes = [];

    for (const [agentIndex, [agentName, agent]] of Object.entries(graph.Agents).entries()) {
        nodes.push({
            data: {
                id: agentIds.get(agentName),
                agentName,
                label: agentName,
                kind: "agent"
            },
            classes: "agent"
        });
        nodes.push({
            data: {
                id: `agent-placeholder-${agentIds.get(agentName)}`,
                parent: agentIds.get(agentName),
                kind: "placeholder"
            },
            position: { x: agentIndex * 320 + 100, y: 100 },
            classes: "placeholder"
        });
    }

    const ownerByNode = new Map();
    for (const [agentName, agent] of Object.entries(graph.Agents)) {
        for (const nodeId of agent.Authority) ownerByNode.set(nodeId, agentName);
    }

    const allocatedIndexByAgent = new Map();
    let unallocatedIndex = 0;
    for (const [nodeId, node] of Object.entries(graph.Nodes)) {
        const parentAgent = ownerByNode.get(nodeId);
        const type = String(node.Type || "Unspecified");
        const classes = isWorkFunction(node) ? "work-function" : "resource";
        let position;
        if (parentAgent) {
            const agentIndex = [...agentIds.keys()].indexOf(parentAgent);
            const allocatedIndex = allocatedIndexByAgent.get(parentAgent) || 0;
            allocatedIndexByAgent.set(parentAgent, allocatedIndex + 1);
            position = {
                x: agentIndex * 320 + 70 + (allocatedIndex % 2) * 130,
                y: 75 + Math.floor(allocatedIndex / 2) * 100
            };
        } else {
            position = {
                x: (unallocatedIndex % 5) * 180,
                y: 380 + Math.floor(unallocatedIndex / 5) * 130
            };
            unallocatedIndex += 1;
        }
        nodes.push({
            data: {
                id: nodeIds.get(nodeId),
                modelId: nodeId,
                label: node.UserData?.FullName || nodeId,
                type,
                kind: isWorkFunction(node) ? "work-function" : "resource",
                ...(parentAgent ? { parent: agentIds.get(parentAgent) } : {})
            },
            position,
            classes
        });
    }

    const edges = graph.Edges.map((edge, index) => ({
        data: {
            id: `model-edge-${index}`,
            modelIndex: index,
            source: nodeIds.get(edge.Source),
            target: nodeIds.get(edge.Target),
            sourceModelId: edge.Source,
            targetModelId: edge.Target
        }
    }));

    cy = cytoscape({
        container: elements.canvas,
        elements: { nodes, edges },
        layout: { name: "preset", fit: true, padding: 38 },
        minZoom: 0.25,
        maxZoom: 2.5,
        selectionType: "additive",
        style: [
            {
                selector: "node",
                style: {
                    "background-color": "#dce9e1",
                    "border-color": "#8fa99a",
                    "border-width": 1,
                    color: "#20322c",
                    label: "data(label)",
                    "font-size": 11,
                    "text-wrap": "wrap",
                    "text-max-width": 120,
                    "text-valign": "center",
                    "text-halign": "center",
                    width: 98,
                    height: 42,
                    "text-outline-color": "#f9fbf8",
                    "text-outline-width": 1
                }
            },
            {
                selector: "node.work-function",
                style: {
                    "background-color": "#f7e3d6",
                    "border-color": "#bd6b49",
                    shape: "round-rectangle"
                }
            },
            {
                selector: "node.resource",
                style: { shape: "ellipse" }
            },
            {
                selector: "node.placeholder",
                style: {
                    width: 1,
                    height: 1,
                    opacity: 0,
                    "background-opacity": 0,
                    "border-opacity": 0,
                    label: ""
                }
            },
            {
                selector: "node.agent",
                style: {
                    "background-color": "#edf3ec",
                    "background-opacity": 0.78,
                    "border-color": "#719c86",
                    "border-style": "dashed",
                    "border-width": 2,
                    "padding": 24,
                    "text-valign": "top",
                    "text-halign": "center",
                    "font-size": 13,
                    "font-weight": "bold",
                    "text-margin-y": 9,
                    "min-width": 150,
                    "min-height": 90,
                    shape: "round-rectangle"
                }
            },
            {
                selector: "edge",
                style: {
                    width: 1.5,
                    "line-color": "#8da198",
                    "target-arrow-color": "#8da198",
                    "target-arrow-shape": "triangle",
                    "curve-style": "bezier",
                    "arrow-scale": 0.85
                }
            },
            {
                selector: "node:selected, edge:selected",
                style: { "border-color": "#c55636", "border-width": 3, "line-color": "#c55636" }
            },
            {
                selector: ".cdnd-drop-target",
                style: { "background-color": "#c7e5d1", "border-color": "#176b5a", "border-width": 4 }
            }
        ]
    });

    cy.cxtmenu({
        selector: "node.work-function",
        commands: (node) => [{
            content: "Edit duration",
            select: () => editDuration(node.data("modelId"))
        }]
    });
    cy.cxtmenu({
        selector: "edge",
        commands: (edge) => [{
            content: "Edit QoS",
            select: () => editQos(edge.data("modelIndex"))
        }]
    });

    dragAndDrop = cy.compoundDragAndDrop({
        grabbedNode: (node) => node.data("kind") === "work-function",
        dropTarget: (node) => node.data("kind") === "agent",
        dropSibling: () => false
    });
    cy.nodes(".placeholder").ungrabify().unselectify();

    const updateAllocations = () => {
        const changed = syncAllocationsFromGraph(agentIds);
        syncEditor();
        if (changed) setStatus("Allocation updated");
    };
    cy.nodes(".work-function").on("dragfree", updateAllocations);
    cy.on("select unselect", refreshSelection);
    cy.on("tap", "node", refreshSelection);
    refreshSelection();
}

function syncAllocationsFromGraph(agentIds) {
    const previous = new Map(Object.entries(model.GraphData.Agents)
        .map(([agentName, agent]) => [agentName, JSON.stringify(agent.Authority)]));
    const ownerByNode = new Map();
    for (const [agentName, agentId] of agentIds) {
        const parent = cy.getElementById(agentId);
        parent.children().forEach((child) => {
            ownerByNode.set(child.data("modelId"), agentName);
        });
    }
    for (const agent of Object.values(model.GraphData.Agents)) agent.Authority = [];
    for (const [nodeId, node] of Object.entries(model.GraphData.Nodes)) {
        if (!isWorkFunction(node)) continue;
        const owner = ownerByNode.get(nodeId);
        if (owner) model.GraphData.Agents[owner].Authority.push(nodeId);
    }
    return Object.entries(model.GraphData.Agents)
        .some(([agentName, agent]) => previous.get(agentName) !== JSON.stringify(agent.Authority));
}

function setModel(value, fileName = activeFileName) {
    model = validateModel(value);
    activeFileName = fileName;
    renderGraph();
    syncEditor();
    elements.runSimulation.disabled = !simulationEnabled;
    setStatus(`Loaded ${activeFileName}`);
}

function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
        try {
            const parsed = JSON.parse(String(reader.result));
            setModel(parsed, file.name);
        } catch (error) {
            setStatus(error.message, "error");
        }
    });
    reader.addEventListener("error", () => {
        setStatus(`Could not read ${file.name}.`, "error");
    });
    reader.readAsText(file);
}

function uniqueKey(base, keys) {
    let key = base;
    let index = 2;
    while (Object.hasOwn(keys, key)) {
        key = `${base}_${index}`;
        index += 1;
    }
    return key;
}

function addNode() {
    const nodes = model.GraphData.Nodes;
    const id = uniqueKey("NewFunction", nodes);
    nodes[id] = {
        Type: "DistributedWorkFunction",
        UserData: { FullName: id, Duration: 0 }
    };
    renderGraph();
    syncEditor();
    setStatus(`Added node "${id}"`);
}

function addAgent() {
    const agents = model.GraphData.Agents;
    const name = uniqueKey("NewAgent", agents);
    agents[name] = { Authority: [] };
    renderGraph();
    syncEditor();
    setStatus(`Added agent "${name}"`);
}

function addEdge() {
    const selectedNodes = cy.$("node:selected").filter((node) => node.data("modelId"));
    if (selectedNodes.length !== 2) {
        setStatus("Select exactly two graph nodes to add an edge.", "error");
        return;
    }
    const source = selectedNodes[0].data("modelId");
    const target = selectedNodes[1].data("modelId");
    model.GraphData.Edges.push({ Source: source, Target: target, UserData: { QOS: "" } });
    renderGraph();
    syncEditor();
    setStatus(`Added edge ${source} → ${target}`);
}

function deleteSelected() {
    const selected = cy.$(":selected");
    if (selected.length === 0) {
        setStatus("Select at least one graph element to delete.", "error");
        return;
    }

    const nodeIds = new Set();
    const edgeIndexes = new Set();
    const agentNames = new Set();
    selected.forEach((element) => {
        if (element.isEdge()) {
            const index = Number(element.id().replace("model-edge-", ""));
            if (Number.isInteger(index)) edgeIndexes.add(index);
        } else if (element.data("kind") === "agent") {
            agentNames.add(element.data("agentName"));
        } else if (element.data("modelId")) {
            nodeIds.add(element.data("modelId"));
        }
    });

    for (const name of agentNames) delete model.GraphData.Agents[name];
    for (const id of nodeIds) delete model.GraphData.Nodes[id];
    for (const agent of Object.values(model.GraphData.Agents)) {
        agent.Authority = agent.Authority.filter((id) => !nodeIds.has(id));
    }
    model.GraphData.Edges = model.GraphData.Edges.filter((edge, index) =>
        !edgeIndexes.has(index) && !nodeIds.has(edge.Source) && !nodeIds.has(edge.Target)
    );
    renderGraph();
    syncEditor();
    setStatus("Selected graph elements deleted");
}

function applyJson() {
    try {
        setModel(JSON.parse(elements.jsonEditor.value));
    } catch (error) {
        setStatus(`JSON was not applied: ${error.message}`, "error");
    }
}

function downloadJson() {
    const blob = new Blob([`${JSON.stringify(model, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = activeFileName.replace(/\.json$/i, "") + "-edited.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("Downloaded edited JSON");
}

async function runSimulation() {
    elements.runSimulation.disabled = true;
    elements.viewResults.hidden = true;
    setStatus("Running WMC simulation…", "loading");
    try {
        setModel(JSON.parse(elements.jsonEditor.value));
        setStatus("Running WMC simulation…", "loading");
        const response = await fetch("/api/runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(model)
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Simulation failed (${response.status}).`);
        }
        if (resultsUrlTemplate) {
            elements.viewResults.href = resultsUrlTemplate.replace(
                "{runId}",
                encodeURIComponent(result.runId)
            );
            elements.viewResults.hidden = false;
        }
        setStatus(`Simulation complete (${result.eventCount} action events)`);
    } catch (error) {
        setStatus(error.message || String(error), "error");
    } finally {
        elements.runSimulation.disabled = false;
    }
}

elements.valueForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        saveDialogValue(elements.valueInput.value);
        elements.valueDialog.close();
    } catch (error) {
        setStatus(`Value was not saved: ${error.message || error}`, "error");
    }
});
elements.valueDialog.addEventListener("close", () => {
    saveDialogValue = null;
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
});

elements.openFile.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
elements.addNode.addEventListener("click", addNode);
elements.addAgent.addEventListener("click", addAgent);
elements.addEdge.addEventListener("click", addEdge);
elements.deleteSelected.addEventListener("click", deleteSelected);
elements.applyJson.addEventListener("click", applyJson);
elements.formatJson.addEventListener("click", () => {
    try {
        elements.jsonEditor.value = JSON.stringify(JSON.parse(elements.jsonEditor.value), null, 2);
        setStatus("JSON formatted");
    } catch (error) {
        setStatus(`JSON is invalid: ${error.message}`, "error");
    }
});
elements.download.addEventListener("click", downloadJson);
elements.runSimulation.addEventListener("click", runSimulation);

async function initialize() {
    let settingsError = null;
    try {
        const response = await fetch("/api/config");
        if (response.status !== 404 && !response.ok) {
            throw new Error(`Could not load server settings (${response.status}).`);
        }
        if (response.status !== 404) {
            const config = await response.json();
            simulationEnabled = config.simulationEnabled === true;
            resultsUrlTemplate = typeof config.resultsUrl === "string" ? config.resultsUrl : null;
            elements.runSimulation.hidden = !simulationEnabled;
            elements.runSimulation.disabled = !simulationEnabled || !model;
        }
    } catch (error) {
        settingsError = `Server settings are unavailable: ${error.message || error}`;
    }

    try {
        const response = await fetch(modelUrl);
        if (!response.ok) {
            throw new Error(`Could not load the example model (${response.status}).`);
        }
        setModel(await response.json(), "example-model.json");
        if (settingsError) {
            setStatus(`Loaded example-model.json. ${settingsError}`, "error");
        }
    } catch (error) {
        setStatus(
            `Could not load the example model: ${error.message || error}. Open a JSON model to begin.`,
            "error"
        );
    }
}

initialize();