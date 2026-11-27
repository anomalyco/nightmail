import { defineConfig } from '@hey-api/openapi-ts';
export default defineConfig({
  input: './dist/openapi-sdk.json',
  output: { path: '../sdk/src', clean: false },
  plugins: ['@hey-api/typescript', '@hey-api/client-fetch', { name: '@hey-api/sdk', auth: true }],
});
