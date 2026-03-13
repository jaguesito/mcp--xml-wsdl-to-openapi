# AWSL to OpenAPI MCP Server

Servidor basado en Model Context Protocol para la conversión automatizada y validada de definiciones de servicio XML (AWSL) a OpenAPI 3.1.

## Requisitos
- Node.js >= 18.0.0
- npm

## Instalación
```bash
npm install
```
Add in your MCP config:
```
{
	"servers": {
		"awsl-to-openapi": {
			"command": "node",
			"args": [
				"/Users/yavac/Repositorio/mcp--xml-wsdl-to-openapi/index.js"
			]
		}
	},
	"inputs": []
}
```
