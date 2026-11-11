/**
 * Read a File as base64-encoded string (without data URL prefix).
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The name a save dialog is opened with for a file a sender named. The MIME
 * filename is the sender's choice, so a path in it would preselect a folder
 * of their choosing; only its last segment is kept.
 */
export function saveDialogName(filename: string | null | undefined): string {
  const base = (filename ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  return base && base !== "." && base !== ".." ? base : "attachment";
}
