Put your character artwork in this folder, named exactly:

    character.png

Tips for the best result:
  - Transparent background PNG (or WebP/SVG, see below).
  - Roughly square or slightly tall, e.g. 512 x 640 px.
  - Draw the character as if it is hanging: the point where the rope
    attaches should be at the very top centre of the image.

Until that file exists, the page shows the built-in CSS jade-and-brass
charm instead, so nothing looks broken.

To use a different filename or format, edit one line in index.html:

    <img class="charm__image" id="charmImage" src="assets/character.png" ... />

To change the charm's size, edit .charm in style.css (width / height).
