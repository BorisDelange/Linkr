import { ZoomableImage } from '@/components/ImageLightbox'

/**
 * Renderer overrides every markdown view shares. Pass as ReactMarkdown's
 * `components`, so an image is enlargeable wherever markdown is rendered — a
 * plugin README, a project summary, a catalog entry, an agent reply.
 *
 * It lives in its own module rather than beside either markdown config: both of
 * them re-export it, and neither should have to depend on the other.
 */
/**
 * A screenshot is legible well before it is page-wide, and the prose around it
 * is `max-w-none` — so on a wide sheet an image stretched to the full column.
 * `!max-w-` because Tailwind Typography styles images as `.prose img`, which
 * outranks a plain utility class. Full size stays one click away in the
 * lightbox.
 */
const IMG_CLASS = '!mx-auto !max-w-full sm:!max-w-[620px] h-auto rounded-md border'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const markdownComponents: Record<string, any> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  img: ({ node: _node, className, ...props }: any) => (
    <ZoomableImage {...props} className={className ? `${IMG_CLASS} ${className}` : IMG_CLASS} />
  ),
}
