# The mark

<img src="png/lockup.png#gh-light-mode-only" width="300"><img src="png/lockup-dark.png#gh-dark-mode-only" width="300">

An **`H` branded with an arrow**. Two posts, and the crossbar is an arrow that runs left to right
and lands on the far post.

It is three things in one picture: the herd `H`, the stamp a line puts on every unit that clears
QC, and the iron a rancher puts on an animal. It also states the product in one stroke — work goes
in one side and comes out the other. Picked over two alternatives in
[#29](https://github.com/jmwind/issue-herd/issues/29), where the runners-up and the reasoning are
on the record.

It stays off everything the software-factory space has converged on — gears, droid faces,
smokestacks, hex grids, gradient blobs, angular industrial wordmarks. The side of the metaphor we
take is the **stockyard**: pens, gates, brands, units moving through in order. We already own that
side by name.

## Files

| File | What it is |
| --- | --- |
| `mark.svg` | the mark alone, on a 96-unit grid — favicons, avatars, anywhere square |
| `lockup.svg` | mark + `issue-herd` wordmark |
| `png/mark.png`, `png/mark-dark.png` | 512×512, transparent |
| `png/lockup.png`, `png/lockup-dark.png` | 1328×384, transparent |

Use the `-dark` PNGs on dark backgrounds. The SVGs do it themselves: they carry a
`prefers-color-scheme` rule, with the light-mode colour left on the element as a presentation
attribute so a renderer that strips `<style>` still gets a visible mark rather than an invisible
one.

## Colour

| Token | Light | Dark |
| --- | --- | --- |
| ink | `#141210` | `#F6F2ED` |
| ember | `#C2521A` | `#C2521A` |

Ember is a hot-iron orange, not a tech blue, and it is on the one element in the mark that is
*doing* something. The mark also works flat, in one colour, either way round.

## Drawing rules

- 96-unit grid, 12-unit stroke, round caps and joins. Keep the two posts at `x=24` and `x=72`.
- Never re-colour the posts and the arrow the same when both are visible; the arrow is what moves.
- Below 16px, drop the arrowhead before you drop anything else.

## Still open

The wordmark in `lockup.svg` is live text (Inter, falling back to the system UI stack), so it
renders differently depending on what the viewer has installed. The PNGs are a fixed render and are
what the README uses. Before this goes anywhere public — a site, a package page, printed anything —
set the wordmark in a licensed face and convert it to outlines.
