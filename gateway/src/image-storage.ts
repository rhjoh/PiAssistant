/**
 * Image Storage Service
 * 
 * Handles saving and loading images to/from disk instead of storing base64 in session.
 * Images are stored in ~/assistant_main/images/ with unique filenames.
 */

import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_IMAGE_DIR = join(homedir(), "assistant_main", "images");

export interface StoredImage {
  path: string;
  mimeType: string;
  size: number;
}

export interface ImageReference {
  type: "image_ref";
  path: string;
  mimeType: string;
}

export class ImageStorage {
  private imageDir: string;

  constructor(imageDir: string = DEFAULT_IMAGE_DIR) {
    this.imageDir = imageDir;
  }

  /**
   * Initialize the image directory
   */
  async init(): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
    console.log(`[ImageStorage] Initialized: ${this.imageDir}`);
  }

  /**
   * Save a base64-encoded image to disk
   * Returns the file path for reference
   */
  async saveImage(base64Data: string, mimeType: string): Promise<StoredImage> {
    // Create unique filename: YYYYMMDD-HHMMSS-{hash}.{ext}
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const hash = createHash("sha256").update(base64Data).digest("hex").slice(0, 8);
    const ext = this.getExtensionFromMimeType(mimeType);
    const filename = `${timestamp}-${hash}.${ext}`;
    const filePath = join(this.imageDir, filename);

    // Decode and save
    const buffer = Buffer.from(base64Data, "base64");
    await writeFile(filePath, buffer);

    console.log(`[ImageStorage] Saved image: ${filename} (${this.formatBytes(buffer.length)})`);

    return {
      path: filePath,
      mimeType,
      size: buffer.length,
    };
  }

  /**
   * Load an image from disk and return base64
   */
  async loadImage(filePath: string): Promise<{ data: string; mimeType: string } | null> {
    try {
      // If relative path, resolve against imageDir
      const resolvedPath = filePath.startsWith("/") ? filePath : join(this.imageDir, filePath);
      
      const buffer = await readFile(resolvedPath);
      const mimeType = this.getMimeTypeFromPath(resolvedPath);
      
      return {
        data: buffer.toString("base64"),
        mimeType,
      };
    } catch (err) {
      console.error(`[ImageStorage] Failed to load image: ${filePath}`, err);
      return null;
    }
  }

  /**
   * Convert image content parts to image_ref format
   * Saves base64 images to disk and returns references
   */
  async convertToReferences(content: unknown[]): Promise<unknown[]> {
    const result: unknown[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") {
        result.push(part);
        continue;
      }

      const p = part as Record<string, unknown>;
      
      // If it's an image with base64 data, save it
      if (p.type === "image" && typeof p.data === "string") {
        const mimeType = (p.mimeType as string) || "image/png";
        const stored = await this.saveImage(p.data, mimeType);
        
        result.push({
          type: "image_ref",
          path: stored.path,
          mimeType: stored.mimeType,
        });
        continue;
      }

      // If it's already a reference, keep it
      if (p.type === "image_ref" && typeof p.path === "string") {
        result.push(part);
        continue;
      }

      result.push(part);
    }

    return result;
  }

  /**
   * Convert image_ref parts back to image parts with base64 data
   * Used when sending to LLM (Pi needs base64)
   */
  async resolveReferences(content: unknown[]): Promise<unknown[]> {
    const result: unknown[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") {
        result.push(part);
        continue;
      }

      const p = part as Record<string, unknown>;
      
      // If it's an image_ref, load the file
      if (p.type === "image_ref" && typeof p.path === "string") {
        const loaded = await this.loadImage(p.path);
        if (loaded) {
          result.push({
            type: "image",
            data: loaded.data,
            mimeType: loaded.mimeType,
          });
        } else {
          // Failed to load, keep as text reference
          result.push({
            type: "text",
            text: `[Image not found: ${p.path}]`,
          });
        }
        continue;
      }

      result.push(part);
    }

    return result;
  }

  /**
   * Sanitize image parts for client history (return file paths, not base64)
   */
  async sanitizeForHistory(content: unknown[]): Promise<unknown[]> {
    const result: unknown[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") {
        result.push(part);
        continue;
      }

      const p = part as Record<string, unknown>;
      
      // Convert base64 images to file paths
      if (p.type === "image" && typeof p.data === "string") {
        const mimeType = (p.mimeType as string) || "image/png";
        const stored = await this.saveImage(p.data, mimeType);
        
        result.push({
          type: "image",
          path: stored.path,
          mimeType: stored.mimeType,
        });
        continue;
      }

      // Keep image_ref as path-only image
      if (p.type === "image_ref" && typeof p.path === "string") {
        result.push({
          type: "image",
          path: p.path,
          mimeType: p.mimeType || "image/png",
        });
        continue;
      }

      result.push(part);
    }

    return result;
  }

  /**
   * Clean up old images (optional maintenance)
   */
  async cleanup(maxAgeDays: number = 30): Promise<number> {
    const files = await readdir(this.imageDir);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = join(this.imageDir, file);
      const stats = await stat(filePath);
      const ageDays = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

      if (ageDays > maxAgeDays) {
        await unlink(filePath);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.log(`[ImageStorage] Cleaned up ${deletedCount} old images`);
    }

    return deletedCount;
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const map: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/bmp": "bmp",
      "image/svg+xml": "svg",
    };
    return map[mimeType] || "png";
  }

  private getMimeTypeFromPath(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
    };
    return map[ext || ""] || "image/png";
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
