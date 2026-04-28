import { openImageInNewTab } from './utils';

export function UserContent({ content, images }: { content: string; images?: string[] }) {
  return (
    <div
      style={{
        borderLeft: '2px solid var(--accent-primary)',
        background: 'var(--user-bg)',
        padding: '12px 16px',
        fontSize: '13px',
        color: 'var(--user-text)',
        lineHeight: '1.6',
        fontFamily: 'var(--font-primary)',
        borderRadius: '0',
        fontWeight: 400,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {content}
      {images && images.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          {images.map((img, idx) => (
            <img
              key={idx}
              src={img}
              alt={`Uploaded ${idx + 1}`}
              style={{
                maxWidth: '200px',
                maxHeight: '200px',
                objectFit: 'cover',
                borderRadius: '0',
                border: '1px solid var(--border-color)',
                cursor: 'pointer'
              }}
              onClick={() => openImageInNewTab(img)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
