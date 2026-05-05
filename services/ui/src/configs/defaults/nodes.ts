import { INodeItem } from "../../types";

const nodes: Record<string, INodeItem> = {
  "entrypoint-398705a7-5bbe-4f53-964a-7fb6b91dd000": {
    key: "entrypoint-398705a7-5bbe-4f53-964a-7fb6b91dd000",
    position: {
      top: 102,
      left: 110
    },
    outputs: ["op_entrypoint-398705a7-5bbe-4f53-964a-7fb6b91dd000"],
    type: "ENTRYPOINT",
    configs: {
      name: "entrypoint"
    },
    data: {},
    inputs: []
  },
  "onexit-e79638ef-a102-4378-ba5d-25a4f4129060": {
    key: "onexit-e79638ef-a102-4378-ba5d-25a4f4129060",
    position: {
      top: 250,
      left: 110
    },
    outputs: ["op_onexit-e79638ef-a102-4378-ba5d-25a4f4129060"],
    type: "ONEXIT",
    configs: {
      name: "onexit"
    },
    data: {},
    inputs: []
  },
  "template-hello-world-8af9-4046-ac3b-b99987b8ef47": {
    key: "template-hello-world-8af9-4046-ac3b-b99987b8ef47",
    position: {
      top: 102,
      left: 350
    },
    inputs: ["ip_template-hello-world-8af9-4046-ac3b-b99987b8ef47"],
    outputs: ["op_template-hello-world-8af9-4046-ac3b-b99987b8ef47"],
    type: "TEMPLATE",
    configs: {
      name: "hello-world"
    },
    data: {
      type: "container",
      when: "",
      template: {
        name: "hello-world",
        container: {
          image: "docker/whalesay",
          command: "cowsay",
          args: "hello world"
        },
        script: {
          image: ""
        },
        resource: {
          action: "",
          manifest: ""
        },
        suspend: {
          duration: ""
        }
      }
    }
  }
};

export default nodes;
