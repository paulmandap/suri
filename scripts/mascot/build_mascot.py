"""Builds Suri's mascot sprites and icons from Paul's ChatGPT sheets (Phase 5, ADR-019).

The sheets came back as JPEGs with a checkerboard painted where transparency
should be, so the background is cut out with a segmentation model (rembg's
BiRefNet) rather than by colour: the silver laptop, the blanket and the eye
highlights share the checkerboard's greys.

  1. Cut-out: assets/mascot/source/*.jpg (or .png) -> assets/mascot/cutout/*.png.
     Skipped when a cut-out is newer than its source (--force redoes it).
  2. Sprites: each figure is found as its own blob, so a tail that strays into
     the next figure's space stays with its owner, and saved as WebP in
     assets/mascot/sprites/. head.json says where the eye patches sit on the
     blank head, because the island draws the eyes there in code.
  3. Icons: the front view's head becomes the tray icon and the app icon.

Run it with Python 3.10+ and rembg (about 500 MB with its model):

  py -3.13 -m venv %LOCALAPPDATA%\\suri-mascot-venv
  %LOCALAPPDATA%\\suri-mascot-venv\\Scripts\\pip install "rembg[cpu]"
  %LOCALAPPDATA%\\suri-mascot-venv\\Scripts\\python scripts\\mascot\\build_mascot.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets" / "mascot" / "source"
CUTOUT = ROOT / "assets" / "mascot" / "cutout"
SPRITES = ROOT / "assets" / "mascot" / "sprites"
MODEL = "birefnet-general-lite"

SHEETS = ["turnaround", "poses", "blank-face", "extras"]

# Figures in reading order (rows top to bottom, then left to right). The
# turnaround came back as two rows of the same four views; the first is used.
NAMES = {
    "turnaround": ["front", "three-quarter", "side", "back"],
    "poses": ["idle", "working", "alert", "happy", "sleepy", "worried"],
    "extras": ["wave", "thumbs-up", "shield", "point"],
}

# Shown at 22-46 px; four times that keeps them sharp on a 200% display.
BODY_HEIGHT = 192
HEAD_HEIGHT = 128
TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]
APP_SIZES = [16, 24, 32, 48, 64, 128, 256]

# A pixel counts as part of a figure from this alpha up; softer fur edges stay
# in the sprite but don't decide where one figure ends and the next begins.
SOLID = 24
# Bridges small gaps, so a prop (the table, the blanket) joins its figure.
BRIDGE_PX = 6


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true", help="cut out every sheet again")
    args = parser.parse_args()
    cut_out(args.force)
    SPRITES.mkdir(parents=True, exist_ok=True)
    sheets = {name: Image.open(CUTOUT / f"{name}.png").convert("RGBA") for name in SHEETS}

    for sheet_name, names in NAMES.items():
        found = figures(sheets[sheet_name])
        if len(found) < len(names):
            raise SystemExit(
                f"{sheet_name}: found {len(found)} figures, expected {len(names)}. "
                "Check assets/mascot/cutout/ (a figure may have merged with its neighbour)."
            )
        for (box, mask), name in zip(found, names):
            sprite = isolate(sheets[sheet_name], box, mask)
            save_webp(fit_height(sprite, BODY_HEIGHT), SPRITES / f"{name}.webp")
            print(f"sprite {name}")

    # The blank face: the big head is the largest figure on its sheet.
    box, mask = max(figures(sheets["blank-face"]), key=lambda f: int(f[1].sum()))
    head = above_hoodie(isolate(sheets["blank-face"], box, mask))
    head = fit_height(head, HEAD_HEIGHT)
    save_webp(head, SPRITES / "head.webp")
    (SPRITES / "head.json").write_text(json.dumps(face_geometry(head), indent=2) + "\n")
    print("sprite head (blank), head.json")

    icons(sheets["turnaround"])


def source_of(name: str) -> Path:
    """The sheet as saved: ChatGPT and browsers hand out JPEG, JFIF, PNG or WebP."""
    for extension in ("jpg", "jpeg", "jfif", "png", "webp"):
        path = SOURCE / f"{name}.{extension}"
        if path.exists():
            return path
    raise SystemExit(f"Missing {name}.jpg (or .png) in {SOURCE}.")


def cut_out(force: bool) -> None:
    """Removes the painted checkerboard. Needs rembg, which only this step imports."""
    CUTOUT.mkdir(parents=True, exist_ok=True)
    session = None
    for name in SHEETS:
        source, target = source_of(name), CUTOUT / f"{name}.png"
        if not force and target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
            continue
        from rembg import new_session, remove

        session = session or new_session(MODEL)
        image = Image.open(source).convert("RGB")
        remove(image, session=session, post_process_mask=True).save(target, optimize=True)
        print(f"cut out {name}")


def figures(sheet: Image.Image) -> list[tuple[tuple[slice, slice], np.ndarray]]:
    """Each figure's box and its own region within it, in reading order."""
    alpha = np.asarray(sheet.getchannel("A"))
    joined = ndimage.binary_dilation(alpha >= SOLID, iterations=BRIDGE_PX)
    labels, _count = ndimage.label(joined)
    found = []
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        if box is None:
            continue
        region = labels[box] == index
        # Specks the cut-out left behind are tiny next to a figure.
        if region.sum() < 0.004 * alpha.size:
            continue
        found.append((box, region))
    return reading_order(found)


def reading_order(found):
    """Rows (figures whose heights overlap), top to bottom, each left to right."""
    rows: list[dict] = []
    for figure in sorted(found, key=lambda f: f[0][0].start):
        top, bottom = figure[0][0].start, figure[0][0].stop
        for row in rows:
            if top < row["bottom"] and bottom > row["top"]:
                row["items"].append(figure)
                row["top"], row["bottom"] = min(row["top"], top), max(row["bottom"], bottom)
                break
        else:
            rows.append({"top": top, "bottom": bottom, "items": [figure]})
    return [f for row in rows for f in sorted(row["items"], key=lambda f: f[0][1].start)]


def isolate(sheet: Image.Image, box, region: np.ndarray) -> Image.Image:
    """One figure alone: its neighbours' pixels inside the box become transparent."""
    pixels = np.asarray(sheet)[box].copy()
    pixels[..., 3] = (pixels[..., 3] * region).astype(np.uint8)
    figure = Image.fromarray(pixels, "RGBA")
    return figure.crop(figure.getchannel("A").point(lambda a: 255 if a > 0 else 0).getbbox())


def above_hoodie(figure: Image.Image) -> Image.Image:
    """The head alone: everything above the first row where the teal hoodie shows.

    A few per cent, not most of the row: the collar's curved top would
    otherwise leave a teal sliver under the chin.
    """
    hsv = np.asarray(figure.convert("RGB").convert("HSV")).astype(int)
    alpha = np.asarray(figure.getchannel("A"))
    teal = (hsv[..., 0] >= 105) & (hsv[..., 0] <= 135) & (hsv[..., 1] > 80) & (alpha > 128)
    solid = (alpha > 128).sum(axis=1)
    share = teal.sum(axis=1) / np.maximum(solid, 1)
    rows = np.nonzero(share > 0.08)[0]
    neck = int(rows[0]) if len(rows) else figure.height
    head = figure.crop((0, 0, figure.width, neck))
    return head.crop(head.getchannel("A").point(lambda a: 255 if a > 0 else 0).getbbox())


def face_geometry(head: Image.Image) -> dict:
    """Where the two dark eye patches and the nose sit, as fractions of the sprite."""
    hsv = np.asarray(head.convert("RGB").convert("HSV")).astype(int)
    alpha = np.asarray(head.getchannel("A"))
    value, saturation = hsv[..., 2], hsv[..., 1]
    opaque = alpha > 200
    # The patches are a soft dark brown; the nose is near-black; the ears are
    # dark brown too, but sit at the sides.
    brown = opaque & (value < 150) & (value > 50) & (saturation > 40)
    nose = opaque & (value <= 50)
    width, height = head.size

    def blobs(mask):
        labels, _ = ndimage.label(mask)
        out = []
        for index, box in enumerate(ndimage.find_objects(labels), start=1):
            if box is None:
                continue
            ys, xs = np.nonzero(labels[box] == index)
            out.append(
                {
                    "area": len(xs),
                    "cx": (box[1].start + xs.mean()) / width,
                    "cy": (box[0].start + ys.mean()) / height,
                    "rx": (box[1].stop - box[1].start) / 2 / width,
                    "ry": (box[0].stop - box[0].start) / 2 / height,
                }
            )
        return out

    inner = [b for b in blobs(brown) if 0.2 < b["cx"] < 0.8 and 0.25 < b["cy"] < 0.8]
    eyes = sorted(sorted(inner, key=lambda b: -b["area"])[:2], key=lambda b: b["cx"])
    noses = [b for b in blobs(nose) if 0.35 < b["cx"] < 0.65]
    if len(eyes) != 2 or not noses:
        raise SystemExit("head: couldn't find both eye patches and the nose on the blank face.")
    snout = max(noses, key=lambda b: b["area"])

    def rounded(b):
        return {k: round(v, 4) for k, v in b.items() if k != "area"}

    return {
        "width": width,
        "height": height,
        "eyes": [rounded(e) for e in eyes],
        "nose": rounded(snout),
    }


def icons(turnaround: Image.Image) -> None:
    """The front view's head, on a square: the tray icon and the app icon."""
    box, region = figures(turnaround)[0]
    head = above_hoodie(isolate(turnaround, box, region))
    side = max(head.size)
    square = Image.new("RGBA", (side, side))
    square.paste(head, ((side - head.width) // 2, (side - head.height) // 2))

    def at(size: int) -> Image.Image:
        return square.convert("RGBa").resize((size, size), Image.LANCZOS).convert("RGBA")

    resources, build = ROOT / "resources", ROOT / "build"
    at(256).save(resources / "tray.ico", sizes=[(s, s) for s in TRAY_SIZES])
    at(256).save(resources / "icon.png", optimize=True)
    at(256).save(build / "icon.ico", sizes=[(s, s) for s in APP_SIZES])
    at(512).save(build / "icon.png", optimize=True)
    print("icons: resources/tray.ico, resources/icon.png, build/icon.ico, build/icon.png")


def fit_height(image: Image.Image, height: int) -> Image.Image:
    """Scaled to a height, through premultiplied alpha so edges don't go dark or light."""
    width = max(1, round(image.width * height / image.height))
    return image.convert("RGBa").resize((width, height), Image.LANCZOS).convert("RGBA")


def save_webp(image: Image.Image, path: Path) -> None:
    image.save(path, "WEBP", quality=90, method=6)


if __name__ == "__main__":
    main()
