import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { XMLParser } from "fast-xml-parser";
import SwaggerParser from "@apidevtools/swagger-parser";
import yaml from "js-yaml";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

const TYPE_MAP = {
  "string": { type: "string" },
  "long": { type: "integer", format: "int64" },
  "integer": { type: "integer", format: "int32" },
  "boolean": { type: "boolean" },
  "timestamp": { type: "string", format: "date-time" },
  "double": { type: "number", format: "double" },
  "float": { type: "number", format: "float" }
};

const server = new Server(
  { name: "awsl-converter-validated", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "convert_awsl",
    description: "Convierte definiciones XML AWSL a contratos OpenAPI 3.1 validados.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Ruta absoluta al archivo .xml" },
        output: { type: "string", description: "Ruta absoluta de salida .yaml" }
      },
      required: ["source", "output"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "convert_awsl") {
    return { content: [{ type: "text", text: "Tool not found" }], isError: true };
  }

  const { source, output } = request.params.arguments;

  try {
    const chunks = [];
    const readStream = fs.createReadStream(source);
    for await (const chunk of readStream) chunks.push(chunk);
    const xmlData = Buffer.concat(chunks).toString("utf-8");

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
    const jsonObj = parser.parse(xmlData);
    const service = jsonObj.service_definition || jsonObj;

    const contract = {
      openapi: "3.1.0",
      info: { 
        title: service["@name"] || "Service API", 
        version: service["@version"] || "1.0.0" 
      },
      paths: {},
      components: { schemas: {} }
    };

    const shapes = [service.shapes?.shape].flat().filter(Boolean);
    shapes.forEach(s => {
      const name = s["@name"];
      if (s["@type"] === "structure") {
        const members = [s.member].flat().filter(Boolean);
        contract.components.schemas[name] = {
          type: "object",
          properties: Object.fromEntries(members.map(m => [
            m["@name"], { $ref: `#/components/schemas/${m["@shape"]}` }
          ])),
          required: members.filter(m => m["@required"] === "true").map(m => m["@name"])
        };
      } else if (s["@type"] === "list") {
        contract.components.schemas[name] = {
          type: "array",
          items: { $ref: `#/components/schemas/${s.member?.["@shape"]}` }
        };
      } else {
        contract.components.schemas[name] = TYPE_MAP[s["@type"]] || { type: "string" };
      }
    });

    const ops = [service.operations?.operation].flat().filter(Boolean);
    ops.forEach(op => {
      const method = (op["@method"] || "post").toLowerCase();
      const pathName = `/${op["@name"].toLowerCase()}`;
      contract.paths[pathName] = {
        [method]: {
          operationId: op["@name"],
          responses: { "200": { 
            description: "Success", 
            content: { "application/json": { schema: { $ref: `#/components/schemas/${op.output?.["@shape"]}` } } } 
          } }
        }
      };
      if (op.input) {
        contract.paths[pathName][method].requestBody = {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${op.input["@shape"]}` } } }
        };
      }
    });

    await SwaggerParser.validate(JSON.parse(JSON.stringify(contract)));
    
    await fsPromises.mkdir(path.dirname(output), { recursive: true });
    await fsPromises.writeFile(output, yaml.dump(contract, { noRefs: true, indent: 2 }));

    return { content: [{ type: "text", text: `Success: ${output}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
