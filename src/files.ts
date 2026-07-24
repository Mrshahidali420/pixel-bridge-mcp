import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

export interface SaveRequest {
  /** File path or directory the caller asked for. */
  outputPath: string;
  /** Optional explicit filename (used when outputPath is a directory). */
  filename?: string;
  /** Fallback stem used when no filename can be derived, e.g. "chatgpt-1699999999". */
  defaultStem: string;
  /** MIME type reported by the source; drives the extension. */
  contentType: string;
  /** Allow clobbering an existing file. Default false. */
  overwrite?: boolean;
}

export interface SavedFile {
  absolutePath: string;
  /** Path relative to the server's working directory (the project). */
  relativePath: string;
  bytes: number;
  contentType: string;
}

export function extForContentType(contentType: string): string {
  const clean = contentType.split(";")[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[clean] ?? "png";
}

function hasImageExt(p: string): boolean {
  const ext = path.extname(p).replace(".", "").toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/**
 * Resolve where an image should land.
 *
 * - outputPath with an image extension  -> treated as the exact target file
 * - otherwise                           -> treated as a directory; filename or
 *                                          defaultStem + detected extension
 * - existing files are never overwritten unless overwrite=true; a numeric
 *   suffix (-1, -2, ...) is appended instead.
 */
export function resolveTargetPath(req: SaveRequest): string {
  let target: string;
  if (!req.filename && hasImageExt(req.outputPath)) {
    target = path.resolve(req.outputPath);
  } else {
    const dir = path.resolve(req.outputPath);
    let name = req.filename ?? `${req.defaultStem}.${extForContentType(req.contentType)}`;
    if (!hasImageExt(name)) {
      name = `${name}.${extForContentType(req.contentType)}`;
    }
    target = path.join(dir, name);
  }

  if (req.overwrite) return target;

  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  let candidate = target;
  for (let i = 1; fs.existsSync(candidate); i++) {
    if (i > 500) {
      throw new Error(`Could not find a free filename near ${target}`);
    }
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

export async function saveImage(req: SaveRequest, data: Buffer): Promise<SavedFile> {
  if (data.length === 0) {
    throw new Error("Refusing to save an empty image buffer");
  }
  const target = resolveTargetPath(req);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data, { flag: req.overwrite ? "w" : "wx" });
  return {
    absolutePath: target,
    relativePath: path.relative(process.cwd(), target),
    bytes: data.length,
    contentType: req.contentType,
  };
}
