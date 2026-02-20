import { cn } from '@/lib/utils'

interface LinkrLogoProps {
  size?: number
  className?: string
  animated?: boolean
}

/**
 * Linkr logo — 3 triangles forming a Y shape.
 * Supports dark/light mode via currentColor and explicit fills.
 * When animated=true, triangles spread apart on hover.
 */
export function LinkrLogo({ size = 24, className, animated = false }: LinkrLogoProps) {
  // The logo is designed in a 100x100 viewBox.
  // 3 triangles meet at center (50, 58), separated by small gaps.
  // Top triangle: cyan gradient
  // Bottom-left triangle: dark navy
  // Bottom-right triangle: medium blue

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 88"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(
        animated && 'scale-[1.06] transition-transform duration-300 ease-in-out group-hover/logo:scale-100',
        className,
      )}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="linkr-top-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#00d4ff" />
          <stop offset="100%" stopColor="#2196F3" />
        </linearGradient>
      </defs>

      {/* Top triangle — coordinates from OpenCV contour detection */}
      <polygon
        points="5.3,0.4 94.7,0.8 49.8,26.6"
        fill="url(#linkr-top-grad)"
      />

      {/* Bottom-left triangle */}
      <polygon
        points="0.9,9.9 45.5,35.4 45.5,86.9"
        className="fill-[#004578] dark:fill-[#5b8cb8]"
      />

      {/* Bottom-right triangle */}
      <polygon
        points="98.6,9.7 54.1,35.4 54.1,86.8"
        className="fill-[#0084d8] dark:fill-[#70b8ff]"
      />
    </svg>
  )
}
