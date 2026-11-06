#!/usr/bin/env python3
"""Build the app icon and the logo mark from design/logo-source.png.

The source is a silver film-strip C on black. Luminance becomes alpha, so the mark can be
tinted by the theme: white on black matches the source exactly, and black on white reads as
a photographic negative, which suits the white theme.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "design" / "logo-source.png"
ASSETS = ROOT / "Cineon" / "Resources" / "Assets.xcassets"

# Bounding box of the mark inside the source, found by thresholding luminance at 80.
MARK_BOX = (397, 365, 863, 867)
BLACK_POINT = 14  # The source's rounded rectangle sits at luminance 4 to 8. Drop it.


def extract_mark() -> Image.Image:
    grey = Image.open(SOURCE).convert("L")
    pad = 8
    box = (MARK_BOX[0] - pad, MARK_BOX[1] - pad, MARK_BOX[2] + pad, MARK_BOX[3] + pad)
    luma = np.asarray(grey.crop(box), dtype=np.float32)
    alpha = np.clip((luma - BLACK_POINT) / (255 - BLACK_POINT), 0, 1)
    rgba = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def squircle_mask(size: int, inset: int, radius: int, scale: int = 4) -> Image.Image:
    """macOS icon body: rounded rectangle on Apple's 1024 grid, supersampled."""
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (inset * scale, inset * scale, (size - inset) * scale - 1, (size - inset) * scale - 1),
        radius=radius * scale,
        fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def make_icon(mark: Image.Image) -> Image.Image:
    size, inset, radius = 1024, 100, 185
    body = size - inset * 2
    mask = squircle_mask(size, inset, radius)

    # Pure black body with a faint lift at the top, so it holds up on a dark Dock.
    yy = np.linspace(0, 1, size, dtype=np.float32)[:, None]
    base = (1 - yy) ** 3 * 22
    layer = np.repeat(base, size, axis=1).astype(np.uint8)
    canvas = Image.merge(
        "RGBA",
        (
            Image.fromarray(layer),
            Image.fromarray(layer),
            Image.fromarray(layer),
            mask,
        ),
    )

    # The mark occupies the same share of the body as it does in the source artwork.
    source_body_width = 897
    width = round(body * (mark.width / source_body_width) * 1.06)
    height = round(width * mark.height / mark.width)
    scaled = mark.resize((width, height), Image.LANCZOS)
    x = (size - width) // 2
    y = (size - height) // 2
    canvas.alpha_composite(scaled, (x, y))

    # Hairline rim, as in the source.
    rim = squircle_mask(size, inset, radius)
    inner = squircle_mask(size, inset + 2, radius - 2)
    rim_alpha = np.asarray(rim, dtype=np.int16) - np.asarray(inner, dtype=np.int16)
    rim_rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rim_rgba[..., :3] = 255
    rim_rgba[..., 3] = np.clip(rim_alpha * 0.14, 0, 255).astype(np.uint8)
    canvas.alpha_composite(Image.fromarray(rim_rgba, "RGBA"))

    # Clip everything to the body.
    r, g, b, a = canvas.split()
    a = Image.fromarray(np.minimum(np.asarray(a), np.asarray(mask)))
    return Image.merge("RGBA", (r, g, b, a))


def make_composer_icon(mark: Image.Image, share: float = 0.66) -> None:
    """Icon Composer document. macOS 26 applies its own mask to this, so the artwork fills the
    whole icon. Older icon formats get placed on a grey plate instead."""
    package = ROOT / "Cineon" / "Resources" / "AppIcon.icon"
    assets = package / "Assets"
    assets.mkdir(parents=True, exist_ok=True)

    canvas = Image.new("RGBA", (1024, 1024), (255, 255, 255, 0))
    width = round(1024 * share)
    height = round(width * mark.height / mark.width)
    scaled = mark.resize((width, height), Image.LANCZOS)
    canvas.paste(scaled, ((1024 - width) // 2, (1024 - height) // 2))
    canvas.save(assets / "mark.png")

    write_json(
        package / "icon.json",
        {
            "fill": {"solid": "srgb:0.00000,0.00000,0.00000,1.00000"},
            "groups": [
                {
                    "layers": [{"glass": False, "image-name": "mark.png", "name": "mark"}],
                    "shadow": {"kind": "none", "opacity": 0},
                    "translucency": {"enabled": False, "value": 0},
                }
            ],
            "supported-platforms": {"squares": ["macOS"]},
        },
    )


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n")


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    write_json(ASSETS / "Contents.json", {"info": {"author": "xcode", "version": 1}})

    mark = extract_mark()

    # Tintable logo mark.
    mark_dir = ASSETS / "LogoMark.imageset"
    mark_dir.mkdir(exist_ok=True)
    mark.save(mark_dir / "logo-mark.png")
    write_json(
        mark_dir / "Contents.json",
        {
            "images": [{"filename": "logo-mark.png", "idiom": "universal"}],
            "info": {"author": "xcode", "version": 1},
            "properties": {"template-rendering-intent": "template"},
        },
    )

    # App icon.
    make_composer_icon(mark)
    icon = make_icon(mark)

    # Contact sheet for checking the result by eye: both themes and small sizes.
    sheet = Image.new("RGB", (1400, 520), (128, 128, 128))
    sheet.paste(icon.resize((512, 512), Image.LANCZOS), (4, 4), icon.resize((512, 512), Image.LANCZOS))
    black = Image.new("RGB", (300, 300), (0, 0, 0))
    m = mark.resize((220, round(220 * mark.height / mark.width)), Image.LANCZOS)
    black.paste(m, (40, 30), m)
    sheet.paste(black, (540, 10))
    white = Image.new("RGB", (300, 300), (255, 255, 255))
    arr = np.asarray(m).copy()
    arr[..., :3] = 0
    neg = Image.fromarray(arr, "RGBA")
    white.paste(neg, (40, 30), neg)
    sheet.paste(white, (860, 10))
    x = 540
    for s in (128, 64, 32, 16):
        small = icon.resize((s, s), Image.LANCZOS)
        sheet.paste(small, (x, 340), small)
        x += s + 20
    sheet.save(ROOT / "design" / "asset-check.png")
    print("assets written")


if __name__ == "__main__":
    main()
