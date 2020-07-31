define([
    'base/js/namespace',
    'base/js/events'
    ], function(Jupyter, events) {

      // For keeping track of canvases and copy-paste function:
      var canvases = {};

      // Web socket for sending canvas data on change
      var socket = new NotateWebSocket();

      // Adds a cell above current cell (will be top if no cells)
      var add_cell = function() {
          Jupyter.notebook.insert_cell_above('code').set_text("");
          Jupyter.notebook.select_prev();
          Jupyter.notebook.execute_cell_and_select_below();
      };
      // Button to add default cell
      var defaultCellButton = function () {
          Jupyter.toolbar.add_buttons_group([
              Jupyter.keyboard_manager.actions.register ({
                  'help': 'Add default cell',
                  'icon' : 'fa-play-circle',
                  'handler': add_cell
              }, 'add-default-cell', 'Default cell')
          ])
      };

      // This function is called when a notebook is started.
      function load_ipython_extension() {

        console.log("Hello");

        // Canvas generation functions
        function create_canvas(width, height) {
            var canvas = document.createElement('canvas');
            canvas.id = 'notate-canvas';
            canvas.width  = width;
            canvas.height = height;
            canvas.style.width  = width/2 + "px";
            canvas.style.height = height/2 + "px";
            canvas.style.display = "inline-block";
            canvas.style.verticalAlign = "middle";
            canvas.style.zIndex = 3; // 2 is the code blocks
            canvas.style.cursor = "default";
            canvas.style.border = "thin solid #aaa";
	        canvas.style.touchAction = "none";

            // Clear bg
            let ctx = canvas.getContext("2d");
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1.0;

            return canvas;
        }

        function attach_handlers(canvas) {

            // Add pen-based draw capabilities to canvas w/ draw library code:
            let notate_canvas = NotateCanvasManager.setup(canvas);

            // Send updates over NotateWebSocket:
            notate_canvas.attachSocket(socket);

            return notate_canvas;
        }

        //     // Initialise application
        //     Board.init(canvas);
        //     Pen.init(Board.ctx);
        //     Pointer.onEmpty = _.debounce(Board.storeMemory.bind(Board), 1500);
        //
        //     // Draw method
        //     function drawOnCanvas(e, pointerObj, Pen) {
        //       if (pointerObj) {
        //         pointerObj.set(Board.getPointerPos(e));
        //         Pen.setPen(Board.ctx, e);
        //
        //         if (pointerObj.pos0.x < 0) {
        //           pointerObj.pos0.x = pointerObj.pos1.x - 1;
        //           pointerObj.pos0.y = pointerObj.pos1.y - 1;
        //         }
        //         Board.ctx.beginPath();
        //         Board.ctx.moveTo(pointerObj.pos0.x, pointerObj.pos0.y)
        //         Board.ctx.lineTo(pointerObj.pos1.x, pointerObj.pos1.y);
        //         Board.ctx.closePath();
        //         Board.ctx.stroke();
        //
        //         pointerObj.pos0.x = pointerObj.pos1.x;
        //         pointerObj.pos0.y = pointerObj.pos1.y;
        //       }
        //     }
        //
        //     // Attach event listener
        //     var pointerDown = function pointerDown(e) {
        //       // Initialise pointer
        //       var pointer = new Pointer(e.pointerId);
        //       pointer.set(Board.getPointerPos(e));
        //
        //       // Get function type
        //       Pen.setFuncType(e);
        //       if (Pen.funcType === Pen.funcTypes.menu) Board.clearMemory();
        //       else drawOnCanvas(e, pointer, Pen);
        //     }
        //     var pointerMove = function pointerMove(e) {
        //       if (Pen.funcType && (Pen.funcType.indexOf(Pen.funcTypes.draw) !== -1)) {
        //
        //         var pointer = Pointer.get(e.pointerId);
        //         drawOnCanvas(e, pointer, Pen);
        //       }
        //     }
        //     var pointerCancel = function pointerLeave(e) {
        //       Pointer.destruct(e.pointerId);
        //     }
        //     Board.dom.addEventListener('pointerdown', pointerDown);
        //     Board.dom.addEventListener('pointermove', pointerMove);
        //     Board.dom.addEventListener('pointerup', pointerCancel);
        //     Board.dom.addEventListener('pointerleave', pointerCancel);
        // }

        // Get all code cells
        var code_cells = Jupyter.notebook.get_cells().filter(
            function(cell) {
                return cell.cell_type == "code";
        });

        // Attach the canvas-tear event handler
        code_cells.forEach(function (cell, i) {
            cm = cell.code_mirror;
            let insert_canvas = function(cm, canvas) {

                // Put canvas at cursor position
                cursorPos = cm.getCursor();
                dummy_idx = "__c_" + Object.keys(canvases).length + "__";
                cm.replaceRange(dummy_idx, cursorPos); // Insert a dummy character at cursor position
                cm.markText({"line":cursorPos.line, "ch":cursorPos.ch}, // replace it with canvas
                            {"line":cursorPos.line, "ch":cursorPos.ch+dummy_idx.length},
                            {replacedWith:canvas});

                return {canvas:canvas, idx:dummy_idx};
            };

            // Insert new canvas on Ctrl+Enter key press:
            cm.addKeyMap({"Ctrl-Enter":function(cm) {
                // Create new canvas element + setup
                let canvas = create_canvas(600, 240);

                // Attach event handlers
                let notate_canvas = attach_handlers(canvas);

                // Insert canvas at cursor position
                let c = insert_canvas(cm, canvas);

                // Index canvas for future reference
                canvases[c.idx] = notate_canvas;
            }});


            cm.on('paste', function(cm, event) {
                txt = event.clipboardData.getData("text")
                console.log("pasted!", txt);
                if (txt in canvases) { // If the pasted text is a NotateCanvas id...
                    event.preventDefault();
                    console.log(txt.substring(4, txt.length-6+4));

                    // Create new canvas element + setup
                    let canvas = create_canvas(600, 240);

                    // Clone copied NotateCanvas, using new DOM canvas
                    clonedNotateCanvas = canvases[txt].clone(canvas);
                    // Add cloned canvas to manager
                    NotateCanvasManager.add(clonedNotateCanvas);

                    // Insert canvas at cursor position
                    let insertEvent = insert_canvas(cm, canvas);
                    let dummy_idx = insertEvent.idx;

                    // Index canvas for future reference
                    canvases[dummy_idx] = clonedNotateCanvas;
                };
            });
        });

        // Add a canvas to the top-level notebook panel element
        // var nb_panel_div = document.getElementById("notebook"); // Jupyter.notebook.element.parentElement;
        // var canvas = document.createElement('canvas');
        // console.log(Jupyter.notebook.element);
        // canvas.id = 'notate-canvas';
        // canvas.width  = nb_panel_div.clientWidth;
        // canvas.height = nb_panel_div.clientHeight;
        // canvas.style.position = "absolute";
        // canvas.style.zIndex = 3; // 2 is the code blocks
        // canvas.style.top = 0;
        // canvas.style.left = 0;
        // nb_panel_div.appendChild(canvas);

        // var ctx = canvas.getContext('2d');
        // $(canvas).on('pointerdown', function (e) {
        //
        //   // Getting coordinates
        //   var left = e.offsetX;
        //   var top = e.offsetY;
        //   console.log(e);
        //
        //   ctx.beginPath();
        //   ctx.moveTo(0, 0);
        //   ctx.lineTo(left, top);
        //   ctx.stroke();
        //
        //   // Detecting the underlying event type
        //   // Can be "mouse", "touch", or "pen"
        //   var underlyingEvent = e.originalEvent.pointerType;
        //
        //   e.preventDefault();
        //
        // });

        // Add a default cell if there are no cells
        // if (Jupyter.notebook.get_cells().length===1){
        //   add_cell();
        // }
        // defaultCellButton();
      }

      return {
        load_ipython_extension: load_ipython_extension
      };
});

// A Stroke is a dict object (struct) with elements:
// { 'pts':[...], 'weight':overall_line_width, 'color':... }
var NotateCanvasManager = (function() {
    const canvases = [];
    return {
        setup: function(canvas) {
            canvases.push( new NotateCanvas(canvas) );
            return canvases[canvases.length-1];
        },
        add: function(notateCanvas) {
            canvases.push( notateCanvas );
        },
        remove: function(canvas) {
            for (var i = 0; i < canvases.length; i++) {
                if (canvases[i].canvas.id === canvas.id) {
                    canvases[i].destruct(); // remove event handlers
                    canvases.splice(i, 1); // remove NotateCanvas at index i
                    return;
                }
            }
        }
    }
}());

// A NotateCanvas wraps a canvas and takes care of setting up
// all the basic drawing events for different platforms.
class NotateCanvas {
    clone(new_canvas_element) { // Clone this NotateCanvas, e.g. to duplicate the HTML canvas.
        var c = new NotateCanvas(new_canvas_element);
        c.canvas.width = this.canvas.width;
        c.canvas.height = this.canvas.height;
        c.canvas.style.width = this.canvas.style.width;
        c.canvas.style.height = this.canvas.style.height;
        c.strokes = JSON.parse(JSON.stringify(this.strokes)); // deep copy stroke data
        c.resolution = this.resolution;
        c.bg_color = this.bg_color;
        c.bg_opacity = this.bg_opacity;
        c.default_linewidth = this.default_linewidth;
        c.clear();
        c.draw();
        return c;
    }
    constructor(canvas_element) {
        this.strokes = [];
        this.canvas = canvas_element;
        this.ctx = this.canvas.getContext('2d', {
            desynchronized: false
        });
        this.ctx.imageSmoothingEnabled = true;

        const default_linewidth = 2;
        const default_color = '#555';
        this.resolution = 2;
        // this.pos = { x:this.canvas.offsetLeft, y:this.canvas.offsetTop };
        this.pos = { x:0, y:0 };
        this.bg_color = '#fff';
        this.bg_opacity = 0.4;
        this.default_linewidth = default_linewidth;

        this.resizing = false;
        this.mouse_down = false;

        this.new_strokes = {};

        // Attach pointer event listeners
        let pointerDown = function pointerDown(e) {
            if (this.resizing === true && e.pointerType === "mouse") {
                this.mouse_down = true;
                e.preventDefault();
                return;
            }
            else if (e.pointerId in this.new_strokes) {
                console.warn('A stroke is already being drawn with this id. Did you forget to cancel?');
                return;
            } else if (e.pointerType === "touch") {
                this.canvas.style.border = "thick solid #000000"
                return;
            }

            // Create new stroke and attach reference
            let s = { pts: [this.getPointerValue(e)], weight:default_linewidth, color:default_color };
            this.new_strokes[e.pointerId] = s;

            this.drawStroke(s);
        }.bind(this);
        let pointerMove = function pointerMove(e) {
            let pos = this.getPointerValue(e);

            // Ensure pointer event is being tracked, if not, err:
            if (e.pointerId in this.new_strokes) {

                // Add point to end of stroke:
                this.new_strokes[e.pointerId].pts.push( pos );

                // Draw new line of stroke:
                this.drawStroke( { pts:this.new_strokes[e.pointerId].pts.slice(-2),
                                 width:this.new_strokes[e.pointerId].weight,
                                 color:this.new_strokes[e.pointerId].color });
            } else if (this.mouse_down && this.resizing) {

                // Resize canvas from bottom-right corner:
                this.canvas.style.width = Math.floor(e.offsetX + 30) + "px";
                this.canvas.style.height = Math.floor(e.offsetY + 30) + "px";
                this.canvas.width = Math.floor(e.offsetX + 30) * 2;
                this.canvas.height = Math.floor(e.offsetY + 30) * 2;
                console.log("moving");
                this.draw();
                e.preventDefault();

            } else {

                if (pos.x >= this.canvas.width - 30 && pos.y >= this.canvas.height - 30) {
                    this.canvas.style.cursor = "se-resize";
                    this.resizing = true;
                }
                else {
                    this.canvas.style.cursor = "auto";
                    this.resizing = false;
                }
            }
        }.bind(this);
        let pointerCancel = function pointerLeave(e) {
            if (e.pointerType === "mouse")
                this.mouse_down = false;

            // Ensure pointer event is being tracked, if not, err:
            if (e.pointerId in this.new_strokes) {

                // Move stroke into the main strokes array:
                this.strokes.push( this.new_strokes[e.pointerId] );
                delete this.new_strokes[e.pointerId];

                // Update backend if defined:
                if (this.socket) {
                    this.socket.sendDrawing(this.strokes, this.canvas.id);
                }
            } else {
                this.canvas.style.border = "thin solid #aaa";
                this.canvas.style.cursor = "auto";
                this.resizing = false;
            }
        }.bind(this);
        this.canvas.addEventListener('pointerdown', pointerDown);
        this.canvas.addEventListener('pointermove', pointerMove);
        this.canvas.addEventListener('pointerup', pointerCancel);
        this.canvas.addEventListener('pointerleave', pointerCancel);
        this.destruct = function() {
            this.canvas.removeEventListener('pointerdown', pointerDown);
            this.canvas.removeEventListener('pointermove', pointerMove);
            this.canvas.removeEventListener('pointerup', pointerCancel);
            this.canvas.removeEventListener('pointerleave', pointerCancel);
        }.bind(this);
    }
    attachSocket(socket) {
        socket.canvas[this.canvas.id] = this;
        this.socket = socket;
    }
    getPointerValue(e) {
        return {
          x: (e.offsetX - this.pos.x) * this.resolution,
          y: (e.offsetY - this.pos.y) * this.resolution,
          p: this.getLineWidthForPointerEvent(e)
        }
    }
    getLineWidthForPointerEvent(e) {
        if (e.pointerType === 'pen') {
            return e.pressure * (this.default_linewidth*2.0);
        } else if (e.pointerType === 'touch') {
            if (e.width < 10 && e.height < 10) {
              return (e.width + e.height) * 2 + 10;
            } else {
              return (e.width + e.height - 40) / 2;
            }
        }

        // Mouse or other type...
        if (e.pressure) return e.pressure * (this.default_linewidth*2.0);
        else            return this.default_linewidth;
    }
    setStrokes(strokes) {
        this.strokes = strokes;
    }
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.bg_color) { // Draw background if set.
            const gl_a = this.ctx.globalAlpha;
            if (this.bg_opacity < 1.0) this.ctx.globalAlpha = this.bg_opacity;
            this.ctx.fillStyle = this.bg_color;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            if (this.bg_opacity < 1.0) this.ctx.globalAlpha = gl_a;
        }
    }
    draw() {
        this.strokes.forEach(this.drawStroke.bind(this));
    }
    drawStroke(s) {
        if (!('pts' in s) || s.pts.length === 0) {
            console.error('Stroke obj has no points.');
            return;
        }

        // Set color and line width values
        const weight = ('weight' in s) ? s.weight : this.default_linewidth;
        this.ctx.lineWidth = weight;
        if ('color' in s) this.ctx.strokeStyle = s.color;

        // Draw stroke as path
        for (var i = 0; i < s.pts.length-1; i++) {
            const p = s.pts[i];
            const q = s.pts[i+1];
            this.ctx.beginPath();
            this.ctx.moveTo(p.x, p.y);
            if ('p' in q) // If pressure is specified...
                this.ctx.lineWidth = q.p * weight;
            this.ctx.lineTo(q.x, q.y);
            this.ctx.closePath();
            this.ctx.stroke();
        }
    }
}

// Sending canvas data to/from a server
class NotateWebSocket {
    constructor() {

        let socket = null;
        let isopen = false;
        this.isopen = isopen;
        this.canvas = {};

        socket = new WebSocket("ws://127.0.0.1:9000");
        socket.binaryType = "arraybuffer";
        this.socket = socket;

        socket.onopen = function() {
           console.log("Connected!");
           this.isopen = true;
        }.bind(this);

        socket.onmessage = function(e) {
           if (typeof e.data == "string") {
              console.log("Text message received: " + e.data);

              // Try to parse as JSON...
              try {
                  let json = JSON.parse(e.data);

                  // Check structure:
                  if (json && json.constructor == Object && 'strokes' in json && 'layer_id' in json) {
                      this.receiveDrawing(json['strokes'], json['layer_id']);
                  } else {
                      throw new Error("Unexpected JSON structure for data: " + e.data);
                  }

              } catch (e) {
                  console.error(e.message);
              }

           } else {
              console.error("Binary data received. Expected JSON string.");
           }
       }.bind(this);

        socket.onclose = function(e) {
           console.log("Connection closed.");
           this.socket = null;
           this.isopen = false;
       }.bind(this);
    }

    // Send an array of arrays of points to the server.
    sendDrawing(strokes, canvas_id) {

        // Check that socket is valid and open:
        if (!this.socket || !this.isopen) {
            console.warn("Cannot send drawing: Socket is not open.");
        } else if (!strokes) {
            console.error("Cannot send drawing: No strokes specified.");
        } else if (!canvas_id) {
            console.error("Cannot send drawing: No canvas id specified.");
        } else {

            // Encode strokes as JSON string and send on socket:
            try {
                let payload = JSON.stringify({'strokes':strokes, 'layer_id':canvas_id });
                this.socket.send(payload);
            } catch (e) {
                console.error(e.message);
            }
        }
    }

    // Receive strokes from the server.
    receiveDrawing(strokes, canvas_id) {
        if (!strokes || (Array.isArray(strokes)) || !('pts' in strokes)) {
            console.error('Receiving ill-formatted strokes', strokes);
        }
        else if (canvas_id in this.canvas) {
            this.canvas[canvas_id].setStrokes(strokes);
        } else {
            console.error('No NotateCanvas attached for id', canvas_id);
        }
    }
}

/* TODO: Move these to separate requirejs modules called from define[] */
// var Board = (function() {
//    var boardObject = {
//      resolution: 2,
//      dom: null,
//      ctx: null,
//      domMem: null,
//      ctxMem: null,
//      bgColor: '#ffffff',
//      pos: {
//        x: 0,
//        y: 0
//      },
//      loadToMemory: function loadToMemory(event) {
//        var imageObj = event.target;
//        this.domMem.width = imageObj.width;
//        this.domMem.height = imageObj.height;
//        this.ctxMem.drawImage(imageObj, 0, 0);
//        this.ctx.drawImage(imageObj, 0, 0);
//      },
//      init: function init(canvas) {
//        this.dom = canvas;
//        this.ctx = this.dom.getContext('2d', {desynchronized: true});
//
//        // Additional Configuration
//        this.ctx.imageSmoothingEnabled = true;
//
//        // Create buffer
//        this.domMem = document.createElement('canvas');
//        this.ctxMem = this.domMem.getContext('2d');
//        this.ctxMem.fillStyle = this.bgColor;
//        // this.ctxMem.fillRect(0,0, this.domMem.width, this.domMem.height);
//
//        // Set up sizing
//        // fitToWindow.bind(this)();
//        // window.addEventListener('resize', fitToWindow.bind(this));
//
//        // Load canvas from local storage
//        localStorage.setItem('dataURL', null); // disable saving for now
//        // if (localStorage.dataURL) {
//        //   var img = new window.Image();
//        //   img.addEventListener('load', this.loadToMemory.bind(this));
//        //   img.setAttribute('src', localStorage.dataURL);
//        // }
//      },
//      getPointerPos: function getPointerPos(event) {
//        return {
//          x: (event.offsetX - this.pos.x) * this.resolution,
//          y: (event.offsetY - this.pos.y) * this.resolution
//        }
//      },
//      storeMemory: function storeMemory() {
//        this.ctxMem.drawImage(this.dom, 0, 0);
//        localStorage.setItem('dataURL', this.domMem.toDataURL());
//      },
//      clearMemory: function clearMemory() {
//        localStorage.clear();
//        this.ctx.fillStyle = this.bgColor;
//        this.ctx.fillRect(0,0, this.dom.width, this.dom.height);
//        this.domMem.width = this.dom.width;
//        this.domMem.height = this.dom.height;
//        this.ctxMem.fillStyle = this.bgColor;
//        this.ctxMem.fillRect(0,0, this.dom.width, this.dom.height);
//      }
//    };
//
//     var fitToWindow = function fitToWindow() {
//       var marginX = 10;
//       var marginY = 10;
//
//       var nb_panel_div = document.getElementById("notebook"); // Jupyter.notebook.element.parentElement;
//
//       var heightCss = nb_panel_div.clientHeight - marginY;
//       var heightCanvas = heightCss * this.resolution;
//       var widthCss = nb_panel_div.clientWidth - marginX;
//       var widthCanvas = widthCss * this.resolution;
//
//       // If new size is larger than memory
//       if (widthCanvas > this.domMem.width || heightCanvas > this.domMem.height) {
//         // Create buffer
//         var bufferCanvas = document.createElement('canvas');
//         var bufferCtx = bufferCanvas.getContext('2d');
//
//         bufferCanvas.width = this.domMem.width;
//         bufferCanvas.height = this.domMem.height;
//
//         // Clear buffer
//         bufferCtx.fillStyle = this.bgColor;
//         // bufferCtx.fillRect(0, 0, widthCanvas, heightCanvas);
//
//         // Save canvas to buffer
//         bufferCtx.drawImage(this.dom, 0, 0);
//
//         // Resize memory
//         if (this.domMem.width < widthCanvas) this.domMem.width = widthCanvas;
//         if (this.domMem.height < heightCanvas) this.domMem.height = heightCanvas;
//         this.ctxMem.drawImage(bufferCanvas, 0, 0);
//       } else {
//         this.ctxMem.drawImage(this.dom, 0 ,0);
//       }
//
//       // resize current canvas
//       this.dom.style.height = heightCss + 'px';
//       this.dom.style.width = widthCss + 'px';
//       this.dom.width = widthCanvas;
//       this.dom.height = heightCanvas;
//       this.ctx.fillStyle = this.bgColor;
//       // this.ctx.fillRect(0,0, this.dom.width, this.dom.height);
//       this.ctx.drawImage(this.domMem, 0, 0);
//
//       this.pos.x = this.dom.offsetLeft;
//       this.pos.y = this.dom.offsetTop;
//     }
//
//    return boardObject;
// })();
// var Pen = (function() {
//   var pen = {
//     colors: {
//       fg: '#555',
//       bg: '#FFF'
//     },
//     lineWidth: 4,
//     type: 'mouse',
//     lineJoin: 'round',
//     funcType: null,
//     funcTypes: {
//       draw: 'draw',
//       erase: 'draw erase',
//       menu: 'menu'
//     },
//     init: function init(context) {
//       context.lineJoin = this.lineJoin;
//       context.lineWidth = this.lineWidth;
//       context.strokeStyle = this.color;
//     },
//     set: function set(context, config) {
//       context.lineWidth = config.lineWidth;
//       context.strokeStyle = config.color;
//       context.lineJoin = this.lineJoin;
//     },
//     setFuncType: function setFuncType(pointerEvent) {
//       if      (checkMenuKey(pointerEvent)) this.funcType = this.funcTypes.menu;
//       else if (checkEraseKeys(pointerEvent)) this.funcType = this.funcTypes.erase;
//       else this.funcType = this.funcTypes.draw;
//       return this.funcType;
//     },
//     setPen: function setPen(context, pointerEvent) {
//       switch(this.funcType) {
//         case this.funcTypes.erase: {
//           this.set(context, {
//             color: this.colors.bg,
//             lineWidth: 25
//           });
//           break;
//         }
//         case this.funcTypes.draw: {
//           this.set(context, {
//             color: this.colors.fg,
//             lineWidth: getLineWidth(pointerEvent)
//           });
//           break;
//         }
//       }
//     },
//     release: function release() {
//       this.funcType = null;
//     }
//   }
//
//   var getLineWidth = function getLineWidth(e) {
//     switch (e.pointerType) {
//       case 'touch': {
//         if (e.width < 10 && e.height < 10) {
//           return (e.width + e.height) * 2 + 10;
//         } else {
//           return (e.width + e.height - 40) / 2;
//         }
//       }
//       case 'pen': return e.pressure * 8;
//       default: return (e.pressure) ? e.pressure * 8 : 4;
//     }
//   }
//
//   var checkEraseKeys = function checkEraseKeys(e) {
//     if (e.buttons === 32) return true;
//     else if (e.buttons === 1 && e.shiftKey) return true;
//     return false;
//   }
//   var checkMenuKey = function checkMenuKey(e) {
//     return (e.buttons === 1 && e.ctrlKey);
//   }
//
//   function openMenu(e) {
//     console.log('Menu', e.pageX, e.pageY);
//   }
//
//   return pen;
// })();
//
//
// /*
//     Singleton that stores pointer events.
// */
// // class PointerManager {
// //     constructor() {
// //         this._
// //     }
// // }
//
// var Pointer = (function() {
//
//   var size = 0;
//   var hashMap = {};
//
//   var Pointer = function Pointer(pointerId) {
//     this.pointerId = pointerId;
//     this.pos1 = {
//       x: -1,
//       y: -1
//     };
//     this.pos0 = {
//       x: -1,
//       y: -1
//     };
//     this.isClicked = false;
//
//     Pointer.addPointer(this);
//   }
//
//   // Static Methodst
//   Pointer.get = function get(pointerId) {
//     return hashMap[pointerId];
//   }
//   Pointer.destruct = function destruct(pointerId) {
//     this.removePointer(pointerId);
//   }
//   Pointer.addPointer = function addPointer(pointer) {
//     hashMap[pointer.pointerId] = pointer;
//     size += 1;
//   }
//   Pointer.removePointer = function removePointer(pointerId) {
//     if (hashMap[pointerId]) {
//       delete hashMap[pointerId];
//       size -= 1;
//       if (size == 0 && Pointer.onEmpty) {
//         Pointer.onEmpty();
//       }
//     }
//   }
//   Pointer.onEmpty = null;
//
//   // OO Methods
//   Pointer.prototype = {
//     constructor: Pointer,
//     release: function release() {
//       this.isClicked = false;
//       this.pos0.y = -1;
//       this.pos0.x = -1;
//     },
//     set: function set(pos) {
//       this.pos1.x = pos.x;
//       this.pos1.y = pos.y;
//     }
//   }
//
//   return Pointer;
// })();
