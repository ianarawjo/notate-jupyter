# Notate (Jupyter Notebook Extension)
### 1. Tear open HTML canvases and draw on them.
Use Ctrl+\ (Backslash) to inject a canvas at the cursor position in the selected cell. Draw on it:
![A handwritten sum equation.](sum_example.png)
### 2. Canvases are auto-passed to Python as 2d NumPy arrays (images) upon run.
In-line, canvases act as variable names. On running the cell, code is silently injected to the top which declares the variables and sets them equal to NumPy image data. (This performs a number of imports: base64, numpy as np, io.BytesIO, and PIL.Image. If you pass the image as a single argument to a function (e.g. foo(*canvas*)) it will also pass the locals() dict as an added '.locals' attribute of the nparray object.)
### 3. Do what you want with the output.
Pass handwritten digits to an MNIST recognizer for all I care! Here's an example of a magical QCR function recognizing a handwritten quantum circuit (function not included!):

![A handwritten quantum circuit magically recognized.](qc_example.png)

### Extra features
- You can copy+paste canvases like you would text.
- Drag sides of canvas to resize. (Pixel-perfect resize is not yet available.)
- Click on a canvas to enter full-screen view. Right now, it only supports a black pen, an eraser, and a 'clear canvas' function. Click off the full-screen view to minimize.

### Required Libraries
- PIL/Pillow (so "from PIL import Image" works)
- NumPy

##### Mileage may vary. Tested on Google Chrome v91.0 with MacOS.
