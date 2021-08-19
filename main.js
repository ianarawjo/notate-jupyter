define([
    'require',
    'jquery',
    'base/js/namespace',
    'base/js/events',
    'notebook/js/codecell'
], function(requirejs, $, Jupyter, events, codecell) {

      // For keeping track of canvases and copy-paste function:
      var canvases = {};
      var CodeCell = codecell.CodeCell;

      // Web socket for sending canvas data on change
      var socket;
      // var socket = new NotateWebSocket();

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

      // Generates unique id for a new canvas
      var uniqueCanvasId = function() {

          // Get all existing ids as numbers, in ascending order
          nums = [];
          for (let id in canvases)
              nums.push(parseInt(id.substring(4, id.length-2)));
          nums.sort(function(a, b) {
              return a - b;
          });

          // Find first unique index not already represented in the list
          let k = 0;
          for (const n of nums) {
              if (k !== n) break;
              k += 1;
          }

          return "__c_"+k+"__";
      };

      // Given a notebook cell, checks what canvases are actually in the cell,
      // and removes any which aren't from the cell's metadata (used on save_notebook()).
      var cleanupCellMetadata = function(cell) {
          if (!('notate_canvi' in cell.metadata)) return;
          let cm = cell.code_mirror;
          let ids = Object.keys(cell.metadata['notate_canvi']);
          for(let idx of ids) {
              // Check if a canvas with this index is in the text of the cell:
              let cursor = cm.getSearchCursor(idx);
              let found = false;
              while(cursor.findNext()) {
                  found = true;
                  break;
              }
              if (!found) { // Delete unused canvases
                  console.log('Deleting unused canvas', idx, 'in cell metadata.');
                  delete cell.metadata['notate_canvi'][idx];
              }
          }
      };

      var initialize = function () {
        // == Add any relative css to the page ==
        // Add Font Awesome 4.7 Icons:
        $('<link/>')
            .attr({
                rel: 'stylesheet',
                type: 'text/css',
                href: requirejs.toUrl('./css/font-awesome.min.css')
            })
            .appendTo('head');
      };

      // This function is called when a notebook is started.
      function load_ipython_extension() {

        // events.on('execute.CodeCell', function(evt, data) {
        //     var cell = data.cell;
        //     var cm = cell.code_mirror;
        //     cm.replaceRange('x = y', {'line':0, 'ch':0});
        //     console.log('HELLO WORLD', cell, data);
        // });

        // Incredibly sketchy wrapper over Jupyter saving.
        // Attempts to cleanup excess metadata in cells before saving.
        var origSaveNotebook = Jupyter.notebook.__proto__.save_notebook.bind(Jupyter.notebook);
        console.log('whaaa');
        Jupyter.notebook.__proto__.save_notebook = function() {
            let cells = Jupyter.notebook.get_cells();
            for (let cell of cells)
                cleanupCellMetadata(cell);
            origSaveNotebook();
        };
        console.log(Jupyter.notebook.save_notebook);

        // See https://github.com/jupyter/notebook/blob/42227e99f98c3f6b2b292cbef85fa643c8396dc9/notebook/static/services/kernels/kernel.js#L728
        function run_code_silently(code, cb) {
            var kernel = Jupyter.notebook.kernel;
            var callbacks = {
                shell : {
                    reply : function(msg) {
                        console.log(msg);
                        if (msg.content.status === 'error') {
                            // handle error
                            console.error('Error running silent code', code);
                        } else {
                            // status is OK
                            cb();
                        }
                    } //execute_reply_callback,
                }
            };
            var options = {
                silent : true,
                user_expressions : {},
                allow_stdin : false
            };
            kernel.execute(code, callbacks, options);
            // console.log('tried to run code', code);
        }

        var shortcuts = {
          'ctrl-enter': function(evt, data) {},
          'shift-enter': function(evt, data) {
              // Running a cell that includes a canvas
              var cell = Jupyter.notebook.get_selected_cell();
              var cm = cell.code_mirror;

              // Find all unique canvas id's in the selected cell
              let activatedCanvasIds = [];
              let cursor = cm.getSearchCursor(/__c_([0-9]+)__/g);
              while(cursor.findNext())
                  activatedCanvasIds.push(cm.getRange(cursor.from(), cursor.to()));

              // Convert canvases to PNGs and encode as base64 str
              // to 'send' to corresponding Python variables:
              let data_urls = {};
              let code = 'import base64\nimport numpy as np\nfrom io import BytesIO\nfrom PIL import Image\n';
              for (let idx of activatedCanvasIds) {
                  if (!(idx in canvases)) {
                      console.warn('@ Run cell: Could not find a notate canvas with id', idx, 'Skipping...');
                      continue;
                  }
                  console.log(idx, canvases[idx]);
                  data_urls[idx] = canvases[idx].toOpaqueDataURL().split(',')[1];
                  code += idx + '=1-np.array(Image.open(BytesIO(base64.b64decode("' + data_urls[idx] + '"))).convert("L"), dtype="uint8")/255\n';
              }

              // Insert artificial code into cell
              cell.get_text = function() {
                  let raw_code = this.code_mirror.getValue();
                  let lines = raw_code.split("\n");
                  let corrected_code = "";
                  lines.forEach((line, i) => {
                      if (line.includes('__c_')) {
                          let idx = line.lastIndexOf('__)');
                          if (idx > -1) {
                              line = line.slice(0, idx+2) + ", locals()" + line.slice(idx+2);
                          }
                      }
                      corrected_code += line + '\n';
                  });
                  return corrected_code;
              }.bind(cell);

              // cm.replaceRange('x = y', {'line':0, 'ch':0});
              // console.log('HELLO WORLD', cell);

              // First run some background code silently to setup the environment
              // for this cell. The __*__ canvases will become numpy 2d arrays (images)
              run_code_silently(code, function () {
                  Jupyter.notebook.execute_cell_and_select_below();

                  // Repair the old get_text so nothing funny happens:
                  cell.get_text = function() {
                      return this.code_mirror.getValue();
                  }.bind(cell);
              });
          }
        }
        Jupyter.notebook.keyboard_manager.edit_shortcuts.add_shortcuts(shortcuts);
        Jupyter.notebook.keyboard_manager.command_shortcuts.add_shortcuts(shortcuts);

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
            canvas.style.border = "thin solid #ccc";
	        canvas.style.touchAction = "none";

            // Set bg color to translucent white. This seems small but it lets
            // the "selection" cursor (blue) show through when the canvas is highlighted as/with text.
            canvas.style.backgroundColor = "rgba(255, 255, 255, 0.4)";

            return canvas;
        }

        function attach_handlers(canvas) {

            // Add pen-based draw capabilities to canvas w/ draw library code:
            let notate_canvas = NotateCanvasManager.setup(canvas);

            // Send updates over NotateWebSocket:
            if (socket)
                notate_canvas.attachSocket(socket);

            return notate_canvas;
        }

        // Get all code cells
        var code_cells = Jupyter.notebook.get_cells().filter(
            function(cell) {
                return cell.cell_type == "code";
        });

        // Attach the canvas-tear event handler
        code_cells.forEach(function (cell, i) {
            let cm = cell.code_mirror;
            let insert_canvas_at_pos = function(from, to, cm, canvas) {
                cm.markText(from, to, {replacedWith:canvas});
            }
            let insert_canvas_at_cursor = function(cm, canvas) {
                // Put canvas at cursor position
                cursorPos = cm.getCursor();
                dummy_idx = uniqueCanvasId();
                cm.replaceRange(dummy_idx, cursorPos); // Insert a dummy character at cursor position
                insert_canvas_at_pos({"line":cursorPos.line, "ch":cursorPos.ch}, // replace it with canvas
                                     {"line":cursorPos.line, "ch":cursorPos.ch+dummy_idx.length},
                                     cm, canvas)
                return {canvas:canvas, idx:dummy_idx};
            };

            // Load + inflate saved canvi from cell metadata
            if ('notate_canvi' in cell.metadata) {
                for (let idx in cell.metadata['notate_canvi']) {
                    // For each 'idx' (e.g. __c_0__), check if its found in the cell's text.
                    // If found, create + insert canvas at that index, +load it with saved image data.
                    let cursor = cm.getSearchCursor(idx);
                    while(cursor.findNext()) {
                        // We've found a match. Insert canvas at position + populate it:
                        // Create new HTML canvas element + setup
                        let canvas = create_canvas(600, 240);

                        // Create NotateCanvas and attach event handlers
                        let notate_canvas = attach_handlers(canvas);

                        // Load canvas with saved image data
                        notate_canvas.loadFromDataURL(cell.metadata['notate_canvi'][idx])

                        // Insert canvas at cursor position in current cell
                        insert_canvas_at_pos(cursor.from(), cursor.to(), cm, canvas);

                        // Index canvas for future reference
                        canvases[idx] = notate_canvas;
                        notate_canvas.idx = idx;
                        notate_canvas.cell = cell;
                    }
                }
            } else
                cell.metadata['notate_canvi'] = {};

            // Insert new canvas on Ctrl+Enter key press:
            cm.addKeyMap({"Ctrl-Enter":function(cm) {
                // Create new HTML canvas element + setup
                let canvas = create_canvas(600, 240);

                // Create NotateCanvas and attach event handlers
                let notate_canvas = attach_handlers(canvas);

                // Insert canvas at cursor position in current cell
                let c = insert_canvas_at_cursor(cm, canvas);

                // Index canvas for future reference
                canvases[c.idx] = notate_canvas;
                notate_canvas.idx = c.idx;
                notate_canvas.cell = cell;
            }});

            // Paste a canvas somewhere else
            let just_pasted = false;
            cm.on('change', function(cm, event) { // 'After paste' event
                if (just_pasted !== false) {
                    console.log('after paste party');

                    // Search the text for matches of NotateCanvas id's.
                    // Replace all matches with corresponding canvas elements.
                    let ids = Object.keys(canvases);
                    for (let id of ids) {
                        if (txt.includes(id)) {
                            console.log('Searching for', id, '...');
                            // For each 'idx' (e.g. __c_0__), check where it's found in the cell's text.
                            // If there isn't a canvas already at that index, create + insert it, +load it with saved image data.
                            let cursor = cm.getSearchCursor(id);
                            while(cursor.findNext()) {
                                // Skip any matches where there's already a canvas...
                                let from = cursor.from();
                                let to = cursor.to();
                                if (cm.findMarks(from, to).length > 0)
                                    continue;

                                console.log('Found match for', id, 'at selection', from, to);

                                // Replace this match with a unique ID.
                                let new_id = uniqueCanvasId();
                                cm.replaceRange(new_id, from, to);

                                // Fix the selection width in case the new_idx is longer than the old one:
                                to = {line: from.line, ch:from.ch + new_id.length};

                                // Insert new canvas at position + populate it:
                                // Create new HTML canvas element + setup
                                let canvas = create_canvas(600, 240);
                                let copied_notate_canvas = canvases[id].clone(canvas);
                                // Add cloned canvas to manager
                                NotateCanvasManager.add(copied_notate_canvas);

                                // Insert canvas at cursor position in current cell
                                insert_canvas_at_pos(from, to, cm, canvas);

                                // Index canvas for future reference
                                canvases[new_id] = copied_notate_canvas;
                                copied_notate_canvas.idx = new_id;
                                copied_notate_canvas.cell = cell;

                                // Save data to cell's metadata
                                cell.metadata['notate_canvi'][new_id] = canvases[id].canvas.toDataURL();
                            }
                        }
                    }

                    cleanupCellMetadata(cell);
                    just_pasted = false;
                }
            });
            cm.on('paste', function(cm, event) {
                txt = event.clipboardData.getData("text");
                console.log("pasted!", txt);
                just_pasted = txt;
            });
        });
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
        let c = new NotateCanvas(new_canvas_element);
        c.canvas.width = this.canvas.width;
        c.canvas.height = this.canvas.height;
        c.canvas.style.width = this.canvas.style.width;
        c.canvas.style.height = this.canvas.style.height;
        c.canvas.style.backgroundColor = this.canvas.style.backgroundColor;
        // c.strokes = JSON.parse(JSON.stringify(this.strokes)); // deep copy stroke data
        c.resolution = this.resolution;
        c.bg_color = this.bg_color;
        c.bg_opacity = this.bg_opacity;
        c.pen_weight = this.pen_weight;
        c.pen_color = this.pen_color;
        c.clear();
        c.loadFromDataURL(this.toDataURL());
        return c;
    }
    constructor(canvas_element) {
        this.strokes = [];
        this.idx = null; // undefined
        this.cell = null;
        this.canvas = canvas_element;
        this.ctx = this.canvas.getContext('2d', {
            desynchronized: false
        });
        this.ctx.imageSmoothingEnabled = true;

        const default_linewidth = 2;
        const default_color = '#000';
        const default_border = "thin solid #ccc";
        const hover_border = "thin solid #888";
        this.pen_color = default_color;
        this.pen_weight = default_linewidth;
        this.resolution = 2;
        // this.pos = { x:this.canvas.offsetLeft, y:this.canvas.offsetTop };
        this.pos = { x:0, y:0 };
        this.bg_color = '#fff';
        this.bg_opacity = 0.4;
        this.default_linewidth = default_linewidth

        this.disable_resize = false;
        this.disable_expand = false;
        this.resizing = false;
        this.pointer_down = false;
        this.pointer_moved = false;

        this.new_strokes = {};

        // Attach pointer event listeners
        let pointerEnter = function pointerEnter(e) {
            let _this = this;
            this.canvas.style.border = hover_border;
            this.saved_img = null;
            this.toImage().then(function (img) {
                _this.saved_img = img;
            });
        }.bind(this);
        let pointerDown = function pointerDown(e) {
            this.pointer_down = true;
            this.pointer_moved = false;

            if (this.resizing && e.pointerType === "mouse") {
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
            let s = { pts: [this.getPointerValue(e)], weight:this.pen_weight, color:this.pen_color };
            this.new_strokes[e.pointerId] = s;

            this.drawStroke(s);
        }.bind(this);
        let pointerMove = function pointerMove(e) {
            let pos = this.getPointerValue(e);
            this.pointer_moved = true;

            // Ensure pointer event is being tracked, if not, err:
            if (e.pointerId in this.new_strokes) {

                // Add point to end of stroke:
                this.new_strokes[e.pointerId].pts.push( pos );

                // Draw new line of stroke:
                this.drawStroke( { pts:this.new_strokes[e.pointerId].pts.slice(-2),
                                 width:this.new_strokes[e.pointerId].weight,
                                 color:this.new_strokes[e.pointerId].color });
            } else if (this.pointer_down && this.resizing) {

                // Resize canvas from bottom-right corner:
                const d = 20;
                if (this.resizing.includes('hor')) {
                    this.canvas.style.width = Math.floor(e.offsetX + d) + "px";
                    this.canvas.width = Math.floor(e.offsetX + d) * 2;
                }
                if (this.resizing.includes('vert')) {
                    this.canvas.style.height = Math.floor(e.offsetY + d) + "px";
                    this.canvas.height = Math.floor(e.offsetY + d) * 2;
                }

                this.loadFromImage(this.saved_img, false);

            } else if (!this.disable_resize) {
                // Bottom-right resize
                const d = 30;
                if (pos.x >= this.canvas.width - d && pos.y >= this.canvas.height - d) {
                    this.canvas.style.cursor = "nwse-resize";
                    this.canvas.style.borderRight = "3px solid gray";
                    this.canvas.style.borderBottom = "3px solid gray";
                    this.resizing = "hor-vert";
                }
                else if (pos.x >= this.canvas.width - d) {
                    this.canvas.style.cursor = "col-resize";
                    this.canvas.style.borderRight = "3px solid gray";
                    this.canvas.style.borderBottom = hover_border;
                    this.resizing = "hor";
                }
                else if (pos.y >= this.canvas.height - d) {
                    this.canvas.style.cursor = "row-resize";
                    this.canvas.style.borderBottom = "3px solid gray";
                    this.canvas.style.borderRight = hover_border;
                    this.resizing = "vert";
                }
                else {
                    this.canvas.style.cursor = "auto";
                    // this.canvas.style.border = "thin solid #aaa";
                    this.canvas.style.border = hover_border;
                    this.resizing = false;
                }
            }
        }.bind(this);
        let pointerLeave = function pointerLeave(e) {
            if (this.pointer_down) {
                if (this.resizing) {
                    // Continue to resize canvas from bottom-right corner:
                    const d = 20;
                    if (this.resizing.includes('hor')) {
                        this.canvas.style.width = Math.floor(e.offsetX + d) + "px";
                        this.canvas.width = Math.floor(e.offsetX + d) * 2;
                    }
                    if (this.resizing.includes('vert')) {
                        this.canvas.style.height = Math.floor(e.offsetY + d) + "px";
                        this.canvas.height = Math.floor(e.offsetY + d) * 2;
                    }
                    this.loadFromImage(this.saved_img, false);
                    e.preventDefault();

                    console.log("pointer leave");
                }
            }
            this.canvas.style.border = default_border;
        }.bind(this);
        let pointerUp = function pointerUp(e) {
            if (this.pointer_down) {
                if (this.resizing !== false) { // End of resizing canvas operation.
                    this.loadFromImage(this.saved_img, false);
                    this.saveMetadataToCell(); // Save resized image to cell metadata
                } else if (!this.pointer_moved && !this.disable_expand) { // Clicked the canvas.
                    // this.canvas.style.border = "thick solid #000000"

                    // A black, translucent background for the popover:
                    let site = document.getElementsByTagName("BODY")[0];
                    let site_bounds = site.getBoundingClientRect();
                    let bg = document.createElement('div');
                    bg.style.backgroundColor = '#000';
                    bg.style.width = "100%";
                    bg.style.height = "100%";
                    bg.style.position = "absolute";
                    bg.style.left = "0px";
                    bg.style.top = "0px";
                    bg.style.zIndex = "5";
                    bg.style.display = "block";
                    bg.style.opacity = 0.8;
                    site.appendChild(bg);

                    // The cloned DOM canvas:
                    let bounds = this.canvas.getBoundingClientRect();
                    let clone = this.canvas.cloneNode(false);
                    const margin = 100;
                    const scaleX = Math.min((site_bounds.width - margin*2) / bounds.width, (site_bounds.height - 110 - margin*2) / bounds.height);
                    clone.style.position = "absolute";
                    clone.style.display = "block";
                    clone.style.left = (site_bounds.width/2 - bounds.width/2) + "px";
                    clone.style.top  = (site_bounds.height/2 - bounds.height/2) + "px";
                    clone.style.width = bounds.width + "px";
                    clone.style.height = bounds.height + "px";
                    clone.style.backgroundColor = "#fff";
                    clone.style.zIndex = "6";
                    clone.style.transform = "scale(" + scaleX + "," + scaleX + ")";
                    clone.style.border = "none";
                    site.appendChild(clone);
                    // clone.style.transition = "transform 1000ms cubic-bezier(0.165, 0.84, 0.44, 1)";

                    // Add pen-based draw capabilities to canvas w/ draw library code:
                    let notate_clone = NotateCanvasManager.setup(clone);
                    notate_clone.bg_opacity = 1.0;
                    notate_clone.disable_resize = true;
                    notate_clone.disable_expand = true;
                    notate_clone.strokes = this.strokes;
                    notate_clone.idx = this.idx;
                    notate_clone.cell = this.cell;
                    notate_clone.clear();
                    // notate_clone.draw();
                    notate_clone.loadFromDataURL(this.toDataURL());

                    // A Trash icon
                    // let trash_container = document.createElement('div');
                    function createIcon(fontAwesomeIconName) {
                        let i = document.createElement('i');
                        i.style.position = "absolute";
                        i.style.display = "block";
                        i.classList.add("fa")
                        i.classList.add("fa-"+fontAwesomeIconName);
                        i.classList.add("fa-2x");
                        // trash_container.style.left = (site_bounds.width/2 - bounds.width/2) + "px";
                        // trash_container.style.top  = (site_bounds.height/2 - bounds.height/2) + "px";
                        // trash_container.appendChild(trash_icon);
                        i.style.zIndex = "7";
                        i.style.opacity = 0.4;
                        i.is_toggled = false; // Special flag
                        return i;
                    }
                    function attachEvents(i, onClickCb) {
                        i.addEventListener('pointerdown', function(e) {
                            this.style.cursor = 'default';
                            this.style.opacity = 0.7;
                            onClickCb();
                        }.bind(i));
                        i.addEventListener('pointermove', function(e) {
                            if (e.pointerType !== "touch")
                                this.style.cursor = 'pointer';
                            this.style.opacity = 1.0;
                        }.bind(i));
                        i.addEventListener('pointerleave', function(e) {
                            if (e.pointerType !== "touch")
                                this.style.cursor = 'default';
                            if (!this.is_toggled)
                                this.style.opacity = 0.4;
                        }.bind(i));
                        return i;
                    }
                    let trash_icon, erase_icon, pen_icon;
                    let rightedge = (site_bounds.width/2 - bounds.width/2*scaleX) + bounds.width*scaleX;
                    let topedge = site_bounds.height/2 - bounds.height/2*scaleX
                    trash_icon = createIcon("trash");
                    trash_icon.style.left = (rightedge - 40) + "px";
                    trash_icon.style.top  = (topedge + 20) + "px";
                    erase_icon = createIcon("eraser");
                    erase_icon.style.left = (rightedge - 80) + "px";
                    erase_icon.style.top  = (topedge + 20) + "px";
                    pen_icon = createIcon("pencil");
                    pen_icon.style.left = (rightedge - 120) + "px";
                    pen_icon.style.top  = (topedge + 20) + "px";
                    pen_icon.style.opacity = 0.8;
                    pen_icon.is_toggled = true;

                    attachEvents(trash_icon, function() {
                        notate_clone.strokes = [];
                        notate_clone.clear();
                    });
                    attachEvents(erase_icon, function() {
                        notate_clone.setPenColor('erase'); // erase is a special setting
                        notate_clone.setPenWeight(5);
                        erase_icon.style.opacity = 0.8;
                        erase_icon.is_toggled = true;
                        pen_icon.style.opacity = 0.4;
                        pen_icon.is_toggled = false;
                    });
                    attachEvents(pen_icon, function() {
                        notate_clone.setPenColor('#000');
                        notate_clone.setPenWeight(2);
                        pen_icon.style.opacity = 0.8;
                        pen_icon.is_toggled = true;
                        erase_icon.style.opacity = 0.4;
                        erase_icon.is_toggled = false;
                    });

                    site.appendChild(trash_icon);
                    site.appendChild(erase_icon);
                    site.appendChild(pen_icon);

                    // Exit modal popover when clicking/touching off the canvas:
                    bg.addEventListener('pointerdown', function(e) {
                        if (e.pointerType === "pen") return;

                        // Transfer strokes back to the parent canvas:
                        this.strokes = notate_clone.strokes;
                        const cloneDataURL = notate_clone.toDataURL();

                        // Remove modal elements:
                        site.removeChild(bg);
                        site.removeChild(clone);
                        site.removeChild(trash_icon);
                        site.removeChild(erase_icon);
                        site.removeChild(pen_icon);
                        NotateCanvasManager.remove(notate_clone);

                        // Update parent canvas:
                        this.clear();
                        this.loadFromDataURL(cloneDataURL);
                        // this.draw();
                    }.bind(this));
                    bg.addEventListener('pointerenter', function(e) {
                        if (e.pointerType === "pen") return;

                        notate_clone.canvas.style.opacity = 0.5;

                    }.bind(this));
                    bg.addEventListener('pointerleave', function(e) {
                        if (e.pointerType === "pen") return;

                        notate_clone.canvas.style.opacity = 1.0;

                    }.bind(this));
                }
            } else {
                console.log("Warning: Pointer was already up.");
            }

            this.pointer_down = false;
            this.resizing = false;
            this.pointer_moved = false;

            // If pointer draw event is being tracked
            if (e.pointerId in this.new_strokes) {

                // Move stroke into the main strokes array:
                this.strokes.push( this.new_strokes[e.pointerId] );
                delete this.new_strokes[e.pointerId];

                // Save img contents of canvas to Jupyter cell metadata
                this.saveMetadataToCell();

                // Update backend if defined:
                if (this.socket) {
                    this.socket.sendDrawing(this.strokes, this.canvas.id);
                }
            } else {
                this.canvas.style.border = default_border;
                this.canvas.style.cursor = "auto";
            }
        }.bind(this);
        this.canvas.addEventListener('pointerenter', pointerEnter);
        this.canvas.addEventListener('pointerdown', pointerDown);
        this.canvas.addEventListener('pointermove', pointerMove);
        this.canvas.addEventListener('pointerup', pointerUp);
        this.canvas.addEventListener('pointerleave', pointerLeave);
        this.destruct = function() {
            this.canvas.removeEventListener('pointerenter', pointerEnter);
            this.canvas.removeEventListener('pointerdown', pointerDown);
            this.canvas.removeEventListener('pointermove', pointerMove);
            this.canvas.removeEventListener('pointerup', pointerUp);
            this.canvas.removeEventListener('pointerleave', pointerLeave);
        }.bind(this);
    }
    attachSocket(socket) {
        socket.canvas[this.canvas.id] = this;
        this.socket = socket;
    }
    loadFromImage(img, changeSize=true) {
        if (!img) return;
        let canvas = this.canvas;
        if (changeSize) {
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.style.width = img.width/2+"px";
            canvas.style.height = img.height/2+"px";
        }
        this.clear();
        canvas.getContext("2d").drawImage(img, 0, 0);
    }
    loadFromDataURL(dataURL, changeSize=true) {
        let img = new Image();
        let canvas = this.canvas;
        img.addEventListener("load", function () {
            if (changeSize) {
                canvas.width = img.width;
                canvas.height = img.height;
                canvas.style.width = img.width/2+"px";
                canvas.style.height = img.height/2+"px";
            }
            canvas.getContext("2d").drawImage(img, 0, 0);
        });
        img.setAttribute("src", dataURL);
    }
    toImage() {
        const src = this.toDataURL();
        return new Promise((resolve, reject) => {
            let img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }
    // Draws white background behind entire canvas before exporting.
    // Only use when you need to export to file or Python.
    toOpaqueDataURL() {
        // create backing canvas
        let backCanvas = document.createElement('canvas');
        backCanvas.width = this.canvas.width;
        backCanvas.height = this.canvas.height;
        let backCtx = backCanvas.getContext('2d');

        // Draw white background and overlay the contents of this canvas
        backCtx.fillStyle = "#fff";
        backCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        backCtx.drawImage(this.canvas, 0,0);

        return backCanvas.toDataURL();
    }
    toDataURL() {
        return this.canvas.toDataURL();
    }
    saveMetadataToCell() {
        if (!this.cell || this.idx == null) {
            console.warn('@ saveMetadataToCell: Could not save metadata with cell and idx', this.cell, this.idx);
            return;
        }
        if (!('notate_canvi' in this.cell.metadata))
            this.cell.metadata['notate_canvi'] = {};
        this.cell.metadata['notate_canvi'][this.idx] = this.canvas.toDataURL();
        console.log('Saved to cell', this.cell, 'for canvas with idx', this.idx);
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
            return e.pressure * (this.pen_weight*2.0);
        } else if (e.pointerType === 'touch') {
            if (e.width < 10 && e.height < 10) {
              return (e.width + e.height) * 2 + 10;
            } else {
              return (e.width + e.height - 40) / 2;
            }
        }

        // Mouse or other type...
        if (e.pressure) return e.pressure * (this.pen_weight*2.0);
        else            return this.pen_weight;
    }
    setStrokes(strokes) {
        this.strokes = strokes;
    }
    setPenColor(color) {
        if (color === 'erase')
            this.ctx.globalCompositeOperation = "destination-out";
        else {
            this.ctx.globalCompositeOperation = "source-over";
            this.pen_color = color;
        }
    }
    setPenWeight(weight) {
        this.pen_weight = weight;
    }
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        // if (this.bg_color) { // Draw background if set.
        //     const gl_a = this.ctx.globalAlpha;
        //     if (this.bg_opacity < 1.0) this.ctx.globalAlpha = this.bg_opacity;
        //     this.ctx.fillStyle = this.bg_color;
        //     this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        //     if (this.bg_opacity < 1.0) this.ctx.globalAlpha = gl_a;
        // }
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

// CodeMirror search extension
// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

(function(mod) {
  mod(CodeMirror)
})(function(CodeMirror) {
  "use strict"
  var Pos = CodeMirror.Pos

  function regexpFlags(regexp) {
    var flags = regexp.flags
    return flags != null ? flags : (regexp.ignoreCase ? "i" : "")
      + (regexp.global ? "g" : "")
      + (regexp.multiline ? "m" : "")
  }

  function ensureFlags(regexp, flags) {
    var current = regexpFlags(regexp), target = current
    for (var i = 0; i < flags.length; i++) if (target.indexOf(flags.charAt(i)) == -1)
      target += flags.charAt(i)
    return current == target ? regexp : new RegExp(regexp.source, target)
  }

  function maybeMultiline(regexp) {
    return /\\s|\\n|\n|\\W|\\D|\[\^/.test(regexp.source)
  }

  function searchRegexpForward(doc, regexp, start) {
    regexp = ensureFlags(regexp, "g")
    for (var line = start.line, ch = start.ch, last = doc.lastLine(); line <= last; line++, ch = 0) {
      regexp.lastIndex = ch
      var string = doc.getLine(line), match = regexp.exec(string)
      if (match)
        return {from: Pos(line, match.index),
                to: Pos(line, match.index + match[0].length),
                match: match}
    }
  }

  function searchRegexpForwardMultiline(doc, regexp, start) {
    if (!maybeMultiline(regexp)) return searchRegexpForward(doc, regexp, start)

    regexp = ensureFlags(regexp, "gm")
    var string, chunk = 1
    for (var line = start.line, last = doc.lastLine(); line <= last;) {
      // This grows the search buffer in exponentially-sized chunks
      // between matches, so that nearby matches are fast and don't
      // require concatenating the whole document (in case we're
      // searching for something that has tons of matches), but at the
      // same time, the amount of retries is limited.
      for (var i = 0; i < chunk; i++) {
        if (line > last) break
        var curLine = doc.getLine(line++)
        string = string == null ? curLine : string + "\n" + curLine
      }
      chunk = chunk * 2
      regexp.lastIndex = start.ch
      var match = regexp.exec(string)
      if (match) {
        var before = string.slice(0, match.index).split("\n"), inside = match[0].split("\n")
        var startLine = start.line + before.length - 1, startCh = before[before.length - 1].length
        return {from: Pos(startLine, startCh),
                to: Pos(startLine + inside.length - 1,
                        inside.length == 1 ? startCh + inside[0].length : inside[inside.length - 1].length),
                match: match}
      }
    }
  }

  function lastMatchIn(string, regexp, endMargin) {
    var match, from = 0
    while (from <= string.length) {
      regexp.lastIndex = from
      var newMatch = regexp.exec(string)
      if (!newMatch) break
      var end = newMatch.index + newMatch[0].length
      if (end > string.length - endMargin) break
      if (!match || end > match.index + match[0].length)
        match = newMatch
      from = newMatch.index + 1
    }
    return match
  }

  function searchRegexpBackward(doc, regexp, start) {
    regexp = ensureFlags(regexp, "g")
    for (var line = start.line, ch = start.ch, first = doc.firstLine(); line >= first; line--, ch = -1) {
      var string = doc.getLine(line)
      var match = lastMatchIn(string, regexp, ch < 0 ? 0 : string.length - ch)
      if (match)
        return {from: Pos(line, match.index),
                to: Pos(line, match.index + match[0].length),
                match: match}
    }
  }

  function searchRegexpBackwardMultiline(doc, regexp, start) {
    if (!maybeMultiline(regexp)) return searchRegexpBackward(doc, regexp, start)
    regexp = ensureFlags(regexp, "gm")
    var string, chunkSize = 1, endMargin = doc.getLine(start.line).length - start.ch
    for (var line = start.line, first = doc.firstLine(); line >= first;) {
      for (var i = 0; i < chunkSize && line >= first; i++) {
        var curLine = doc.getLine(line--)
        string = string == null ? curLine : curLine + "\n" + string
      }
      chunkSize *= 2

      var match = lastMatchIn(string, regexp, endMargin)
      if (match) {
        var before = string.slice(0, match.index).split("\n"), inside = match[0].split("\n")
        var startLine = line + before.length, startCh = before[before.length - 1].length
        return {from: Pos(startLine, startCh),
                to: Pos(startLine + inside.length - 1,
                        inside.length == 1 ? startCh + inside[0].length : inside[inside.length - 1].length),
                match: match}
      }
    }
  }

  var doFold, noFold
  if (String.prototype.normalize) {
    doFold = function(str) { return str.normalize("NFD").toLowerCase() }
    noFold = function(str) { return str.normalize("NFD") }
  } else {
    doFold = function(str) { return str.toLowerCase() }
    noFold = function(str) { return str }
  }

  // Maps a position in a case-folded line back to a position in the original line
  // (compensating for codepoints increasing in number during folding)
  function adjustPos(orig, folded, pos, foldFunc) {
    if (orig.length == folded.length) return pos
    for (var min = 0, max = pos + Math.max(0, orig.length - folded.length);;) {
      if (min == max) return min
      var mid = (min + max) >> 1
      var len = foldFunc(orig.slice(0, mid)).length
      if (len == pos) return mid
      else if (len > pos) max = mid
      else min = mid + 1
    }
  }

  function searchStringForward(doc, query, start, caseFold) {
    // Empty string would match anything and never progress, so we
    // define it to match nothing instead.
    if (!query.length) return null
    var fold = caseFold ? doFold : noFold
    var lines = fold(query).split(/\r|\n\r?/)

    search: for (var line = start.line, ch = start.ch, last = doc.lastLine() + 1 - lines.length; line <= last; line++, ch = 0) {
      var orig = doc.getLine(line).slice(ch), string = fold(orig)
      if (lines.length == 1) {
        var found = string.indexOf(lines[0])
        if (found == -1) continue search
        var start = adjustPos(orig, string, found, fold) + ch
        return {from: Pos(line, adjustPos(orig, string, found, fold) + ch),
                to: Pos(line, adjustPos(orig, string, found + lines[0].length, fold) + ch)}
      } else {
        var cutFrom = string.length - lines[0].length
        if (string.slice(cutFrom) != lines[0]) continue search
        for (var i = 1; i < lines.length - 1; i++)
          if (fold(doc.getLine(line + i)) != lines[i]) continue search
        var end = doc.getLine(line + lines.length - 1), endString = fold(end), lastLine = lines[lines.length - 1]
        if (endString.slice(0, lastLine.length) != lastLine) continue search
        return {from: Pos(line, adjustPos(orig, string, cutFrom, fold) + ch),
                to: Pos(line + lines.length - 1, adjustPos(end, endString, lastLine.length, fold))}
      }
    }
  }

  function searchStringBackward(doc, query, start, caseFold) {
    if (!query.length) return null
    var fold = caseFold ? doFold : noFold
    var lines = fold(query).split(/\r|\n\r?/)

    search: for (var line = start.line, ch = start.ch, first = doc.firstLine() - 1 + lines.length; line >= first; line--, ch = -1) {
      var orig = doc.getLine(line)
      if (ch > -1) orig = orig.slice(0, ch)
      var string = fold(orig)
      if (lines.length == 1) {
        var found = string.lastIndexOf(lines[0])
        if (found == -1) continue search
        return {from: Pos(line, adjustPos(orig, string, found, fold)),
                to: Pos(line, adjustPos(orig, string, found + lines[0].length, fold))}
      } else {
        var lastLine = lines[lines.length - 1]
        if (string.slice(0, lastLine.length) != lastLine) continue search
        for (var i = 1, start = line - lines.length + 1; i < lines.length - 1; i++)
          if (fold(doc.getLine(start + i)) != lines[i]) continue search
        var top = doc.getLine(line + 1 - lines.length), topString = fold(top)
        if (topString.slice(topString.length - lines[0].length) != lines[0]) continue search
        return {from: Pos(line + 1 - lines.length, adjustPos(top, topString, top.length - lines[0].length, fold)),
                to: Pos(line, adjustPos(orig, string, lastLine.length, fold))}
      }
    }
  }

  function SearchCursor(doc, query, pos, options) {
    this.atOccurrence = false
    this.doc = doc
    pos = pos ? doc.clipPos(pos) : Pos(0, 0)
    this.pos = {from: pos, to: pos}

    var caseFold
    if (typeof options == "object") {
      caseFold = options.caseFold
    } else { // Backwards compat for when caseFold was the 4th argument
      caseFold = options
      options = null
    }

    if (typeof query == "string") {
      if (caseFold == null) caseFold = false
      this.matches = function(reverse, pos) {
        return (reverse ? searchStringBackward : searchStringForward)(doc, query, pos, caseFold)
      }
    } else {
      query = ensureFlags(query, "gm")
      if (!options || options.multiline !== false)
        this.matches = function(reverse, pos) {
          return (reverse ? searchRegexpBackwardMultiline : searchRegexpForwardMultiline)(doc, query, pos)
        }
      else
        this.matches = function(reverse, pos) {
          return (reverse ? searchRegexpBackward : searchRegexpForward)(doc, query, pos)
        }
    }
  }

  SearchCursor.prototype = {
    findNext: function() {return this.find(false)},
    findPrevious: function() {return this.find(true)},

    find: function(reverse) {
      var result = this.matches(reverse, this.doc.clipPos(reverse ? this.pos.from : this.pos.to))

      // Implements weird auto-growing behavior on null-matches for
      // backwards-compatibility with the vim code (unfortunately)
      while (result && CodeMirror.cmpPos(result.from, result.to) == 0) {
        if (reverse) {
          if (result.from.ch) result.from = Pos(result.from.line, result.from.ch - 1)
          else if (result.from.line == this.doc.firstLine()) result = null
          else result = this.matches(reverse, this.doc.clipPos(Pos(result.from.line - 1)))
        } else {
          if (result.to.ch < this.doc.getLine(result.to.line).length) result.to = Pos(result.to.line, result.to.ch + 1)
          else if (result.to.line == this.doc.lastLine()) result = null
          else result = this.matches(reverse, Pos(result.to.line + 1, 0))
        }
      }

      if (result) {
        this.pos = result
        this.atOccurrence = true
        return this.pos.match || true
      } else {
        var end = Pos(reverse ? this.doc.firstLine() : this.doc.lastLine() + 1, 0)
        this.pos = {from: end, to: end}
        return this.atOccurrence = false
      }
    },

    from: function() {if (this.atOccurrence) return this.pos.from},
    to: function() {if (this.atOccurrence) return this.pos.to},

    replace: function(newText, origin) {
      if (!this.atOccurrence) return
      var lines = CodeMirror.splitLines(newText)
      this.doc.replaceRange(lines, this.pos.from, this.pos.to, origin)
      this.pos.to = Pos(this.pos.from.line + lines.length - 1,
                        lines[lines.length - 1].length + (lines.length == 1 ? this.pos.from.ch : 0))
    }
  }

  CodeMirror.defineExtension("getSearchCursor", function(query, pos, caseFold) {
    return new SearchCursor(this.doc, query, pos, caseFold)
  })
  CodeMirror.defineDocExtension("getSearchCursor", function(query, pos, caseFold) {
    return new SearchCursor(this, query, pos, caseFold)
  })

  CodeMirror.defineExtension("selectMatches", function(query, caseFold) {
    var ranges = []
    var cur = this.getSearchCursor(query, this.getCursor("from"), caseFold)
    while (cur.findNext()) {
      if (CodeMirror.cmpPos(cur.to(), this.getCursor("to")) > 0) break
      ranges.push({anchor: cur.from(), head: cur.to()})
    }
    if (ranges.length)
      this.setSelections(ranges, 0)
  })
});
