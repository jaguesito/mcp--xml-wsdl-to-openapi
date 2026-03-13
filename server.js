import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { XMLParser } from "fast-xml-parser";
import SwaggerParser from "@apidevtools/swagger-parser"; // Validador
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
  "double": { type: "number", format: "double" }
};

const server = new Server(
  { name: "node-validated-converter", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "convert_and_validate_awsl",
    description: "Convierte AWSL a OpenAPI y valida el esquema resultante.",
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
  if (request.params.name !== "convert_and_validate_awsl") {
    return { content: [{ type: "text", text: "Tool not found" }], isError: true };
  }

  const { source, output } = request.params.arguments;

  try {
    // 1. Procesamiento XML (Optimizado con Buffers)
    const chunks = [];
    const readStream = fs.createReadStream(source);
    for await (const chunk of readStream) chunks.push(chunk);
    const xmlData = Buffer.concat(chunks).toString("utf-8");

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
    const jsonObj = parser.parse(xmlData);
    const service = jsonObj.service_definition || jsonObj;

    // 2. Construcción del Objeto OpenAPI
    const contract = {
      openapi: "3.1.0",
      info: { title: service["@name"] || "API", version: service["@version"] || "1.0.0" },
      paths: {},
      components: { schemas: {} }
    };

    // Lógica de mapeo (Simplificada para brevedad)
    const shapes = [service.shapes?.shape].flat().filter(Boolean);
    shapes.forEach(s => {
      if (s["@type"] === "structure") {
        const members = [s.member].flat().filter(Boolean);
        contract.components.schemas[s["@name"]] = {
          type: "object",
          properties: Object.fromEntries(members.map(m => [m["@name"], { $ref: `#/components/schemas/${m["@shape"]}` }]))
        };
      } else {
        contract.components.schemas[s["@name"]] = TYPE_MAP[s["@type"]] || { type: "string" };
      }
    });

    // 3. VALIDACIÓN CRÍTICA
    // SwaggerParser.validate() lanza una excepción si el objeto no cumple el estándar.
    // Usamos una copia profunda para evitar mutaciones durante la validación.
    try {
      await SwaggerParser.validate(JSON.parse(JSON.stringify(contract)));
    } catch (schemaError) {
      return { 
        content: [{ type: "text", text: `Error de esquema OpenAPI: ${schemaError.message}` }], 
        isError: true 
      };
    }

    // 4. Escritura solo si la validación fue exitosa
    await fsPromises.mkdir(path.dirname(output), { recursive: true });
    await fsPromises.writeFile(output, yaml.dump(contract, { noRefs: true }));

    return { content: [{ type: "text", text: `✅ Contrato validado y guardado en: ${output}` }] };

  } catch (err) {
    return { content: [{ type: "text", text: `Fallo crítico: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
