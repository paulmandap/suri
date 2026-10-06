# Suri's mascot sheets

Save the images from ChatGPT in this folder, with these names:

| File             | From                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `turnaround.png` | Prompt 1: the same meerkat from four sides                          |
| `poses.png`      | Prompt 2: six poses, one per mood                                   |
| `blank-face.png` | Prompt 3: the face without eyes or mouth (Suri draws those in code) |
| `extras.png`     | Prompt 4, optional: wave, thumbs up, shield, pointing               |

Phase 5 cuts them into sprites (in `assets/mascot/sprites/`) and animates them in code.

## How to use the prompts

1. Open **one new ChatGPT chat** and send Prompt 1. If the four views don't match each other, reply "make all four views the exact same character, same size".
2. In the **same chat**, send Prompt 2, then Prompt 3 (Prompt 4 is optional).
3. If a later image drifts from the character, upload the turnaround again and say "match this character exactly".
4. Download each image at full size (PNG) and save it here with the name above. If one comes back without a transparent background, ask for "the same image with a transparent background", or just save it as it is.

## Prompt 1 — turnaround sheet

```
Create a character turnaround sheet for an original mascot (not based on any existing cartoon character): a small, chubby baby meerkat called Suri, a friendly lookout who keeps watch over a programmer's AI assistant.

Style: high-quality stylized 3D render, like a premium vinyl collectible toy. Soft rounded shapes, smooth matte materials with a subtle soft-fur texture, gentle studio lighting, soft ambient occlusion. Cute, clean and simple, not realistic.

Design: big round head (about half of the total height), short round body, small paws, short thick tail. A bold, simple silhouette that is still easy to recognise at 48 pixels tall. Large glossy dark eyes with one small white highlight, dark meerkat eye patches, a tiny dark nose, a small friendly smile, small rounded ears.
Colours: warm sandy-beige fur, lighter cream face and belly, dark brown ear tips and eye patches. It wears a small teal hoodie (#2DD4BF) with the hood down and no text or logo.

Layout: ONE landscape image (3:2) showing the SAME character four times, side by side in four equal columns: front view, three-quarter view facing left, side profile facing left, back view. Standing upright on its hind legs in a relaxed neutral pose, arms at its sides. Same size, same scale and same height in every view, all on the same baseline, evenly spaced, nothing overlapping or cut off.

Background: fully transparent PNG. No floor, no cast shadow, no text, no labels, no watermark.
```

## Prompt 2 — pose sheet (same chat)

```
Using exactly the same character from the turnaround sheet (same proportions, colours, materials and teal hoodie), make a pose sheet: ONE landscape image (3:2) with six full-body front views in a 3 × 2 grid of equal cells, same scale and same baseline in every cell:
1. Idle: relaxed, calm little smile.
2. Working: sitting and typing on a tiny laptop, focused eyes.
3. Alert: the classic meerkat lookout, standing extra tall on tiptoes, ears up, eyes wide, one paw shading its eyes as if it spotted something.
4. Happy: jumping with both arms up, eyes closed in happy arcs, big smile.
5. Sleepy: sitting, head drooping, eyes closed.
6. Worried: paws on its cheeks, eyebrows tilted up, small frown.
Fully transparent background, no text, no labels, no shadows on the ground.
```

## Prompt 3 — blank face (same chat)

```
Same character again, two versions side by side in ONE landscape image, fully transparent background:
Left: full body, front view, exactly the same pose and scale as the front view in the turnaround sheet.
Right: head and shoulders only, front view, larger.
In BOTH versions remove the eyes, eyebrows and mouth completely and leave the face smooth and empty. Keep the dark eye-patch shapes as soft colour areas (with no eyes inside them) and keep the nose. No text, no labels.
```

## Prompt 4 — extras (optional, same chat)

```
Same character, ONE landscape image with four full-body front views in a row, same scale, fully transparent background, no text:
1. Waving hello with one paw.
2. Thumbs up.
3. Holding up a small round teal shield in front of itself, as if blocking something.
4. Pointing to the right with one paw, looking where it points.
```
