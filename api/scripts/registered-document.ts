/// <reference types="@cloudflare/workers-types" />
// Internal checks exercise every registered OpenAPI operation, including the dashboard's.
import { createOpenApiApp } from '../src/app.js';
import { createRegisteredDocument } from '../src/openapi-docs.js';

export const registeredDocument = createRegisteredDocument(await createOpenApiApp());
