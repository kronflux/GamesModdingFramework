export default {
  id: "dummy",
  name: "Dummy",
  version: "0.0.0",
  async detect() {
    return {
      engine: {
        id: "dummy",
        version: "1.0.0",
        confidence: "observed",
        selected: true,
        alternatives: [],
        evidence: [
          {
            claim: "dummy fixture marker",
            confidence: "observed",
            authority: "shipped-artifact",
            source: "test/fixtures/dummy-engine",
          },
        ],
      },
      markers: { antiCheat: [], online: false, launcher: null },
      paths: {},
      notes: [],
      unknowns: [],
    };
  },
  capabilities() {
    return [{ id: "code", support: "full", requires: [], reason: "fixture" }];
  },
  operations: [
    {
      id: "dummy.ping",
      title: "Ping",
      summary: "Return pong.",
      engine: "dummy",
      inputs: { type: "object", properties: {}, required: [] },
      outputs: { type: "object", properties: { pong: { type: "boolean" } } },
      effects: ["read"],
      requires: [],
      gates: ["auto"],
      skill: "gmf-investigate",
      docs: [],
      handler: async () => ({ data: { pong: true }, evidence: [] }),
    },
  ],
};
