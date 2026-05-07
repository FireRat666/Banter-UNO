# Banter UNO!

A fully functional UNO game for Banter spaces.

## Features
- Support for 2-10 players.
- Persistent state management via BanterSpace.
- Configurable position, rotation, and instance names.
- Automatic hand management and turn handling.

## How to add to your space

To add UNO to your Banter space, simply include the `uno.js` script in your HTML file. You can configure its placement and behavior using attributes on the `<script>` tag.

### Basic Implementation

```html
<script src="https://uno.firer.at/uno.js"
        position="0 0 0"
        rotation="0 0 0"
        instance="my-uno-game"></script>
```

### Script Parameters

| Parameter | Default | Description |
| :--- | :--- | :--- |
| `position` | `0 0 2` | The world position where the UNO table will be spawned (X Y Z). |
| `rotation` | `0 0 0` | The rotation of the UNO table (Euler angles: X Y Z). |
| `instance` | `demo-uno` | A unique identifier for the game state. Use different instance IDs if you want multiple independent games in the same space. |
| `debug` | `false` | Enables debug logging in the console if set to `true`. |

## Example `index.html`

```html
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:title" content="My Banter Space">
  </head>
  <body>
    <!-- Load UNO Game -->
    <script src="https://uno.firer.at/uno.js"
            position="0 0 2"
            rotation="0 180 0"
            instance="lobby-uno"></script>
  </body>
</html>
```

## Attribution

This UNO game is based on previous works:
*   **Original "Holograms Against Humanity" (AltspaceVR adaptation):** Derogatory, falkrons, schmidtec
*   **Ported to Banter:** Shane
*   **improved, Fixed and ported from A-Frame:** FireRat

The sound assets used in this project are derived from the original "Holograms Against Humanity" project.

## How it works

The game uses the Banter SDK to create game objects, UI elements, and manage network state.

1. **Initialization**: The script reads parameters from its own tag or URL search params.
2. **Environment**: It builds the UNO table, card deck, and player areas.
3. **State**: Game state is synchronized across all players using `BS.BanterScene` state events.
4. **Turns**: Players take turns playing cards or drawing from the deck. The game automatically handles special cards like Skip, Reverse, and Wild cards.
