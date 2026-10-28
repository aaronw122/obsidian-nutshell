# Nutshell

Expandable, inline explanations for your notes. Click a `:term` and its explanation opens in a small card right next to it, without leaving the note or scrolling to a glossary.

The name and the idea come from [Nicky Case](https://ncase.me)'s [Nutshell](https://ncase.me/nutshell/).

## Why

Notes often need a side explanation: a definition, a derivation, or background a reader may or may not need. Putting it inline clutters the note for readers who already know it. Putting it in a footnote or another note makes everyone else jump away and lose their place.

Nutshell keeps the explanation one click away, in context. Readers who need it open it, and readers who don't never see it.

## What it does

- Click a term to open a floating card with its explanation. The note never reflows.
- Cards are rendered by Obsidian itself, so math, images, links and formatting all work.
- Terms can sit inside cards, and cards open on top of each other. Closing a card closes the cards opened from it.
- Works in reading view and Live Preview. Source mode shows the raw markdown.
- You can edit a definition from its card with the pencil button.
- Keyboard: `Enter`/`Space` on a focused term opens it, and `Esc` closes the top card.

## Usage

### Inline terms

```markdown
Water forms a [:crystal]%% A solid whose atoms sit in a repeating pattern. %% when it freezes.
```

The definition is kept in an Obsidian comment (`%% … %%`) right after the term, so reading view hides it even when the plugin is off. A bare `[:crystal]` is a term with no definition yet.

The easy way to make one: select a word or phrase and run **Create nutshell from selection** from the command palette. With nothing selected, it uses the word under the cursor. The card opens in edit mode so you can type the definition. You can bind the command to a hotkey in **Settings → Hotkeys**.

### Heading terms (Nicky Case's syntax)

Link a term to a heading, and the card shows that heading's section:

```markdown
We model the rate with a [:beta distribution](<#Beta Distribution>).

## :Beta Distribution
A probability distribution on [0, 1], shaped by two parameters α and β.
%% end %%
```

- Start the link text with a colon (`[:label]`). Put the target in angle brackets (`<#Heading With Spaces>`) so spaces work.
- A heading that starts with a colon (`## :Beta Distribution`) is a hidden definition. It is removed from the reading view of the note and only shows up in cards. Leave the colon out when linking to it. Matching ignores case.
- A section ends at the next heading of the same or higher level, or at a line containing only `%% end %%`.
- Links to headings in other notes work too: `[:term](<Other Note#Heading>)`.

Without the plugin, these are ordinary heading links, so your notes still read fine anywhere else.

### Known limitations

- Hidden `:` headings still appear in the Outline pane.
- Block references (`#^block`) aren't supported as targets.

## Installing

**From Community Plugins:** open **Settings → Community plugins → Browse**, search for "Nutshell", then install and enable it.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/nutshell/`, then enable the plugin in **Settings → Community plugins**.

## Contributing

Bug reports, ideas and pull requests are welcome.

- **Bugs:** open an issue with your Obsidian version, the markdown that triggers the bug, what you expected, and what happened. Include any console errors (`Cmd/Ctrl+Shift+I`).
- **Features:** open an issue before starting anything large, so we can agree on the approach first.
- **Pull requests:** keep each PR focused on one change. Describe how you tested it in both reading view and Live Preview.

Development setup:

```sh
git clone https://github.com/aaronw122/obsidian-nutshell
cd obsidian-nutshell
npm install
npm run dev      # rebuilds main.js on change
npm run build    # type-check and production build
```

To test in a vault, symlink the repo folder to `<vault>/.obsidian/plugins/nutshell`. The [Hot Reload](https://github.com/pjeby/hot-reload) plugin will reload it on each rebuild.

Code layout:

| File | Responsibility |
|---|---|
| `terms.ts` | Term syntax: parsing and writing `[:label]` terms |
| `main.ts` | Plugin entry, reading view, popup cards, heading resolution |
| `livePreview.ts` | Live Preview decorations |
| `cardEditor.ts` | The editor inside a card |
| `styles.css` | Styles, using only Obsidian theme variables |

## Credits

The name, the `:term` syntax, the hidden `:` heading convention, and the whole idea of expandable explanations come from **[Nutshell](https://ncase.me/nutshell/) by [Nicky Case](https://ncase.me)**. This plugin is an independent Obsidian adaptation and isn't affiliated with Nicky Case. Go read their work.

## License

[MIT](LICENSE) © Aaron Williams
