/** YouTube's play-button mark, to show where a video comes from. */
export function YouTubeIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={Math.round(size * 0.7)} viewBox="0 0 20 14" aria-hidden="true" focusable="false">
      <rect width="20" height="14" rx="4" fill="#ff0033" />
      <path d="M8 4.1v5.8L13 7z" fill="#fff" />
    </svg>
  );
}
