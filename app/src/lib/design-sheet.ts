// The design sheet (features/design-sheet): every token and shared component on one page, at /_design-sheet. It exists in
// the dev server and in a build made with VITE_DESIGN_SHEET=1; any other build leaves it out, and nothing links to it.
export const designSheetEnabled = import.meta.env.DEV || import.meta.env.VITE_DESIGN_SHEET === '1'
export const DESIGN_SHEET_PATH = '/_design-sheet'
