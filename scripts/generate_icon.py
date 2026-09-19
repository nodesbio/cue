"""
Cue app icon generator — complementary to Jarvis iOS icon.

Design language:
  - Deep teal background (#1E5068) matching Jarvis
  - White flat elements, no gradients
  - Motif: teleprompter scroll (3 lines of text) inside a rounded rectangle,
    with a classic broadcast cue dot (filled circle) top-right
  - Clean, geometric, purely iconographic
"""

from PIL import Image, ImageDraw
import math, os

SIZE = 1024
BG   = (30, 80, 104)   # #1E5068 — matches Jarvis
FG   = (255, 255, 255) # white
DIM  = (255, 255, 255, 60)  # subtle dim white for secondary lines

def make_icon(size=SIZE):
    img  = Image.new("RGBA", (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    s    = size / 1024  # scale factor

    # ── Rounded-rect "display screen" ─────────────────────────────────────
    # Represents the teleprompter / G1 display pane
    pad   = int(160 * s)
    r     = int(80 * s)   # corner radius
    x0, y0 = pad, int(200 * s)
    x1, y1 = size - pad, int(720 * s)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=r, outline=FG,
                           width=int(40 * s))

    # ── Three text lines inside the screen ───────────────────────────────
    line_w   = int(380 * s)
    line_h   = int(28 * s)
    line_x0  = int(250 * s)
    gaps     = [int(340 * s), int(460 * s), int(570 * s)]  # y centres
    for i, cy in enumerate(gaps):
        w = line_w if i == 1 else int(line_w * 0.72)  # middle line full width
        draw.rounded_rectangle(
            [line_x0, cy - line_h//2, line_x0 + w, cy + line_h//2],
            radius=line_h//2,
            fill=FG,
        )

    # ── Cue dot (broadcast cue mark) ─────────────────────────────────────
    # Top-right corner of the screen, half inside / half outside the rect
    dot_cx = int(820 * s)
    dot_cy = int(220 * s)
    dot_r  = int(68 * s)
    # White filled circle
    draw.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=FG,
    )
    # Teal inner circle to create a ring effect (cleaner at small sizes)
    inner_r = int(36 * s)
    draw.ellipse(
        [dot_cx - inner_r, dot_cy - inner_r, dot_cx + inner_r, dot_cy + inner_r],
        fill=BG,
    )

    return img

def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "assets", "images")
    os.makedirs(out_dir, exist_ok=True)

    icon = make_icon(1024)
    out_path = os.path.join(out_dir, "icon-1024.png")
    icon.convert("RGB").save(out_path, "PNG")
    print(f"Saved: {out_path}")

    # Also save a preview at 180 (iPhone home screen @3x)
    preview = icon.resize((180, 180), Image.LANCZOS)
    prev_path = os.path.join(out_dir, "icon-preview-180.png")
    preview.convert("RGB").save(prev_path, "PNG")
    print(f"Preview: {prev_path}")

if __name__ == "__main__":
    main()
