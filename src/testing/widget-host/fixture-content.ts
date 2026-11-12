// Fixture content shared by the Node fixture seeder and the browser-side scenarios.

export const LARGE_FILE_PATH = "src/generated/table.ts";
export const LARGE_FILE_ROWS = 1200;

/** The large generated file; `variant` changes every row so a rewrite produces a large diff. */
export function largeFileContent(variant: "original" | "rewritten"): string {
  const lines = ["// Generated fixture data. Do not edit by hand.", "export const rows = ["];
  for (let index = 1; index <= LARGE_FILE_ROWS; index += 1) {
    const id = String(index).padStart(4, "0");
    lines.push(
      variant === "original"
        ? `  { id: ${index}, label: "row ${id}", value: ${(index * 7) % 97} },`
        : `  { id: ${index}, label: "Row #${id}", amount: ${(index * 11) % 89}, active: ${index % 3 === 0} },`,
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}
