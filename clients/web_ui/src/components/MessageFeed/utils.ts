export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function isLikelyBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 128 || trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(trimmed);
}

export function base64ToBlobUrl(base64: string, mimeType: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch {
    return null;
  }
}

export function toOpenableImageUrl(source: string): string {
  if (source.startsWith('data:')) {
    const match = source.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return source;
    const [, mimeType, data] = match;
    return base64ToBlobUrl(data, mimeType) ?? source;
  }
  if (isLikelyBase64(source)) {
    return base64ToBlobUrl(source, 'image/png') ?? `data:image/png;base64,${source}`;
  }
  return source;
}

export function openImageInNewTab(source: string): void {
  const openUrl = toOpenableImageUrl(source);
  window.open(openUrl, '_blank', 'noopener,noreferrer');
  if (openUrl.startsWith('blob:')) {
    setTimeout(() => URL.revokeObjectURL(openUrl), 60_000);
  }
}

export function extractImagePath(content: string): string | null {
  const imagePathRegex = /["']?(\/\/[^"'\s]+\.(?:png|jpg|jpeg|gif|webp|bmp))["']?/i;
  const match = content.match(imagePathRegex);
  return match ? match[1] : null;
}
