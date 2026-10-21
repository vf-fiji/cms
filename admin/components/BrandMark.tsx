/** The VodaForge mark: a "V" struck like metal on an anvil, with a spark. */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 6.5 11 19l6.5-12.5" />
        <path d="M19.5 3.2v2.6M18.2 4.5h2.6" strokeWidth="1.8" />
      </svg>
    </div>
  );
}

export const PRODUCT_NAME = "VodaForge";
export const PRODUCT_TAGLINE = "Where digital experiences are built";
