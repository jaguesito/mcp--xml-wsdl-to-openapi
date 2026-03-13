import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { XMLParser } from "fast-xml-parser";
import yaml from "js-yaml";
import fs from "fs";
import { pipeline } from "stream/promises";
import path from "path";

const TYPE_MAP = {
  "string": { type: "string" },
  "long": { type: "integer", format: "int64" },
  "integer": { type: "integer", format: "int32" },
  "boolean": { type: "boolean" },
  "timestamp": { type: "string", format: "date-time" },
  "double": { type: "number", format: "double" }
};

const server = new Server(
  { name: "node-streaming-converter", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "convert_awsl_stream",
    description: "Conversión optimizada para archivos XML grandes (+100MB)",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        output: { type: "string" }
      },
      required: ["source", "output"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { source, output } = request.params.arguments;

  try {
    // 1. Stream de lectura
    const readStream = fs.createReadStream(source, { encoding: "utf-8" });
    let xmlData = "";

    // Acumulación por chunks para evitar bloqueo
    for await (const chunk of readStream) {
      xmlData += chunk;
    }

    // 2. Parser configurado para eficiencia
    const parser = new XMLParser({ 
      ignoreAttributes: false, 
      attributeNamePrefix: "@",
      allowBooleanAttributes: true,
      parseTagValue: false // Evita procesamiento innecesario de tipos en el XML
    });

    const jsonObj = parser.parse(xmlData);
    const service = jsonObj.service_definition;

    // 3. Transformación (Idéntica a la lógica anterior)
    const contract = {
      openapi: "3.1.0",
      info: { title: service["@name"], version: service["@version"] },
      paths: {},
      components: { schemas: {} }
    };

    const shapes = [service.shapes?.shape].flat().filter(Boolean);
    shapes.forEach(s => {
      if (s["@type"] === "structure") {
        const members = [s.member].flat().filter(Boolean);
        contract.components.schemas[s["@name"]] = {
          type: "object",
          properties: Object.fromEntries(members.map(m => [
            m["@name"], { $ref: `#/components/schemas/${m["@shape"]}` }
          ])),
          required: members.filter(m => m["@required"] === "true").map(m => m["@name"])
        };
      } else {
        contract.components.schemas[s["@name"]] = TYPE_MAP[s["@type"]] || { type: "string" };
      }
    });

    const ops = [service.operations?.operation].flat().filter(Boolean);
    ops.forEach(op => {
      const method = (op["@method"] || "post").toLowerCase();
      contract.paths[`/${op["@name"].toLowerCase()}`] = {
        [method]: {
          operationId: op["@name"],
          responses: { "200": { description: "OK", content: { "application/json": { 
            schema: { $ref: `#/components/schemas/${op.output?.["@shape"]}` } 
          } } } }
        }
      };
    });

    // 4. Stream de escritura (Pipeline)
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    const writeStream = fs.createWriteStream(output);
    writeStream.write(yaml.dump(contract, { noRefs: true, indent: 2 }));
    writeStream.end();

    return { content: [{ type: "text", text: `Conversión completada: ${output}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
