/** The VodaForge mark: the red "VF" monogram with a hammer struck through it. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return <img className="brand-mark" src="/_reef/brand/vodaforge-mark-192.png?v=2" width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

export const PRODUCT_NAME = "VodaForge";
export const PRODUCT_TAGLINE = "Where digital experiences are built";
