// Notate: Jupyter Notebook Extension for writing/drawing inside an iPython notebook.
// Copyright (C) 2021-2022 Ian Arawjo
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Lesser General Public License v3 as published by
// the Free Software Foundation.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Lesser General Public License v3 for more details.
//
// You should have received a copy of the GNU Lesser General Public License v3
// along with this program.  If not, see <https://www.gnu.org/licenses/lgpl-3.0.en.html>.

define([
    'require',
    'jquery',
    'base/js/namespace',
    'base/js/events',
    'notebook/js/codecell',
    'nbextensions/notate-jupyter/libs/spectrum.min',
], function(requirejs, $, Jupyter, events, codecell) {

      // The Python code silectly injected when cells are run:
      const PYCODE_SETUP = `
import base64
import numpy as np
from io import BytesIO
from PIL import Image
class NotateArray(np.ndarray):
    def __new__(cls, input_array, locals=None):
        obj = np.asarray(input_array).view(cls)
        obj.locals = locals
        return obj

    def __array_finalize__(self, obj):
        if obj is None: return
        self.locals = getattr(obj, 'locals', None)
`;

        // Logging infrastructure
        var Logger = (function() {
            const ALSO_PRINT_TO_CONSOLE = true;
            let _log = [];
            return {
                log: function(evtname, info) {
                    if (ALSO_PRINT_TO_CONSOLE) console.log(evtname, info);
                    _log.push([Date.now().toString(), evtname, info]);
                },
                logCodeCellChange : function(event) {
                    let data = "";
                    if (event.removed.length > 0 && (event.removed[0].length > 0 || event.removed.length > 1))
                        data = "-:"+Date.now().toString()+":"+event.removed.join('\n')+':'+event.from.line+','+event.from.ch+':'+event.to.line+","+event.to.ch;
                    if (event.text.length > 0 && (event.text[0].length > 0 || event.text.length > 1))
                        data = "+:"+Date.now().toString()+":"+event.text.join('\n')+':'+event.from.line+','+event.from.ch+':'+event.to.line+","+event.to.ch;
                    _log.push(data);
                },
                lastLogType: function() {
                    if (_log.length === 0) return "event";
                    return typeof _log[_log.length-1] === "string" ? "code_edit" : "event";
                },
                getData: function() {
                    return _log;
                },
                clear: function() {
                    _log = [];
                    return true;
                },
                clearCache: function() {
                    _log = [];
                    const cells = Jupyter.notebook.get_cells();
                    if (cells.length > 0) {
                        // Append general log
                        if ('log' in cells[0].metadata)
                            cells[0].metadata['log'] = [];
                    }
                    return true;
                }
            }
        }());

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

      // var initialize = function () {
      //   // == Add any relative css to the page ==
      //   // Add Font Awesome 4.7 Icons:
      //   $('<link/>')
      //       .attr({
      //           rel: 'stylesheet',
      //           type: 'text/css',
      //           href: requirejs.toUrl('./css/font-awesome.min.css')
      //       })
      //       .appendTo('head');
      // };


      function initialize() {

        // events.on('execute.CodeCell', function(evt, data) {
        //     var cell = data.cell;
        //     var cm = cell.code_mirror;
        //     cm.replaceRange('x = y', {'line':0, 'ch':0});
        //     console.log('HELLO WORLD', cell, data);
        // });

        Logger.log("Initialize", Jupyter.notebook.notebook_path);

        // Attach window focus change callbacks
        window.onfocus = function () {
            Logger.log("Window", "focused")
        };
        window.onblur = function () {
            Logger.log('Window', "blurred");
        };


        // Incredibly sketchy wrapper over Jupyter saving.
        // Attempts to cleanup excess metadata in cells before saving.
        var origSaveNotebook = Jupyter.notebook.__proto__.save_notebook.bind(Jupyter.notebook);
        Jupyter.notebook.__proto__.save_notebook = function() {
            let cells = Jupyter.notebook.get_cells();
            for (let cell of cells)
                cleanupCellMetadata(cell);

            // Append log data as metadata to first cell of the notebook
            // (could be any cell really)
            if (cells.length > 0) {
                // Append general log
                if ('log' in cells[0].metadata) // Append to existing
                    cells[0].metadata['log'] = cells[0].metadata['log'].concat(Logger.getData());
                else // Create new entry to metadata to store logs
                    cells[0].metadata['log'] = Logger.getData();
                Logger.clear(); // Clear the local log data, since we just appended it to the end of the saved notebook's metadata
            }

            origSaveNotebook();
        };

        // See https://github.com/jupyter/notebook/blob/42227e99f98c3f6b2b292cbef85fa643c8396dc9/notebook/static/services/kernels/kernel.js#L728
        function run_code_silently(code, cb) {
            var kernel = Jupyter.notebook.kernel;
            var callbacks = {
                shell : {
                    reply : function(msg) {
                        // console.log(msg);
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

        // Intercept running code cells to convert canvases
        let runCodeForCell = function(cell, cb) {
            // Running a cell that includes a canvas
            var cm = cell.code_mirror;

            // Find all unique canvas id's in the selected cell
            let activatedCanvasIds = [];
            let cursor = cm.getSearchCursor(/__c_([0-9]+)__/g);
            while(cursor.findNext())
                activatedCanvasIds.push(cm.getRange(cursor.from(), cursor.to()));

            // Convert canvases to PNGs and encode as base64 str
            // to 'send' to corresponding Python variables:
            let data_urls = {};
            let code = PYCODE_SETUP;// 'import base64\nimport numpy as np\nfrom io import BytesIO\nfrom PIL import Image\n';
            let injected_code = false;
            for (let idx of activatedCanvasIds) {
                if (!(idx in canvases)) {
                    console.warn('@ Run cell: Could not find a notate canvas with id', idx, 'Skipping...');
                    continue;
                }
                data_urls[idx] = canvases[idx].toOpaqueDataURL().split(',')[1];
                code += idx + '=np.array(Image.open(BytesIO(base64.b64decode("' + data_urls[idx] + '"))).convert("RGB"), dtype="uint8")\n';
                injected_code = true;
            }

            // Log the original val of get_text
            // if (injected_code) Logger.log("Silent execute", code);
            Logger.log("Execute:cell", cell.get_text());

            // Alter 'get_text' to insert artificial code into cell where canvases are
            cell.get_text = function() {
                let raw_code = this.code_mirror.getValue();
                let lines = raw_code.split("\n");
                let corrected_code = "";
                lines.forEach((line, i) => {
                    if (line.includes('__c_')) {
                        let idx = line.lastIndexOf('__)');
                        if (idx > -1) {
                            let beg_igx = line.lastIndexOf('__c_')
                            line = line.slice(0, beg_igx) + "NotateArray(" + line.slice(beg_igx, idx+2) + ", locals())" + line.slice(idx+2);
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
                // Call execute_cell(), which triggers our hijacked get_text() method
                cb();

                // Repair the old get_text so nothing funny happens:
                cell.get_text = function() {
                    return this.code_mirror.getValue();
                }.bind(cell);

                // Wait for output and log it
                let output_cb = function(event, cells) {
                    if (!('cell' in cells)) {
                        console.warn('@ finished_execute callback: Could not determine executed cell.');
                        return;
                    }

                    // Log output
                    const output = cells.cell.output_area.outputs;
                    output.forEach(function(out) {
                        const outtype = out.output_type;
                        if (outtype == 'error') { // The cell errored while executing, spitting out an execution error msg
                            Logger.log('Execution:'+outtype+":"+out.ename+':'+out.evalue, out.traceback.join('\n\n\n'));
                        } else {
                            let text = "(unknown)";
                            if ('data' in out && 'text/plain' in out.data)
                                text = out.data['text/plain'];
                            else if ('text' in out)
                                text = out.text;
                            Logger.log('Execution:'+outtype, text);
                        }
                    });
                    // Cleanup --Remove our custom cb from events
                    cells.cell.events.off('finished_execute.CodeCell', output_cb);
                };
                cell.events.on('finished_execute.CodeCell', output_cb);
            });
        }


        // var origExecuteCell = Jupyter.notebook.__proto__.execute_cells.bind(Jupyter.notebook);
        // Jupyter.notebook.__proto__.execute_cells = function() {
        //     console.log("heloooo");
        //     let cell = Jupyter.notebook.get_selected_cell();
        //     runCodeForCell(cell, origExecuteCell);
        // };

        // Hijack the core "execute" method for running code in cells.
        Jupyter.CodeCell.prototype.__execute = Jupyter.CodeCell.prototype.execute;
        Jupyter.CodeCell.prototype.execute = function(stop_on_error) {
          runCodeForCell(this, this.__execute.bind(this));
        };

        // var shortcuts = {
        //   'ctrl-enter': function(pager, evt) {
        //       let cell = Jupyter.notebook.get_selected_cell();
        //       runCodeForCell(cell, function() { Jupyter.notebook.execute_cell(); });
        //   },
        //   'shift-enter': function(pager, evt) {
        //       let cell = Jupyter.notebook.get_selected_cell();
        //       runCodeForCell(cell, function() { Jupyter.notebook.execute_cell_and_select_below(); });
        //   }
        // };
        // Jupyter.notebook.keyboard_manager.edit_shortcuts.add_shortcuts(shortcuts);
        // Jupyter.notebook.keyboard_manager.command_shortcuts.add_shortcuts(shortcuts);

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

        // Get all code cells
        var code_cells = Jupyter.notebook.get_cells().filter(
            function(cell) {
                return cell.cell_type == "code";
        });

        // Attach the canvas-tear event handler
        let attachCanvasEventHandlers = function(cell) {
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
                        let canvas = create_canvas(600, 340);

                        // Create NotateCanvas and attach event handlers
                        let notate_canvas = NotateCanvasManager.setup(canvas);

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
            cm.addKeyMap({"Ctrl-\\":function(cm) {

                // Create new HTML canvas element + setup
                let canvas = create_canvas(600, 340);

                // Create NotateCanvas and attach event handlers
                let notate_canvas = NotateCanvasManager.setup(canvas);

                // Insert canvas at cursor position in current cell
                let c = insert_canvas_at_cursor(cm, canvas);

                Logger.log("Created new canvas with Ctrl-\\", "id:"+c.idx);

                // Index canvas for future reference
                canvases[c.idx] = notate_canvas;
                notate_canvas.idx = c.idx;
                notate_canvas.cell = cell;
            }});

            // Paste a canvas somewhere else
            let just_pasted = false;
            cm.on('change', function(cm, event) { // 'After paste' event

                // Log a snapshot of the text in the cell at the start of editing the code
                if (Logger.lastLogType() !== "code_edit")
                    Logger.log("Editing:cell:begin", cell.get_text());

                // Log change to code cell
                Logger.logCodeCellChange(event);

                if (just_pasted !== false) {
                    let txt = just_pasted;

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

                                Logger.log("Pasted", "canvas_duplicated:"+id);

                                // Replace this match with a unique ID.
                                let new_id = uniqueCanvasId();
                                cm.replaceRange(new_id, from, to);

                                // Fix the selection width in case the new_idx is longer than the old one:
                                to = {line: from.line, ch:from.ch + new_id.length};

                                // Insert new canvas at position + populate it:
                                // Create new HTML canvas element + setup
                                let canvas = create_canvas(600, 340);
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
            cm.on('copy', function(cm, event) {
                let txt = window.getSelection().toString(); // kind of a hack, but the following 'correct' way doesn't work: event.clipboardData.getData("text");
                Logger.log("Copied", "raw_text:"+txt);
            });
            cm.on('cut', function(cm, event) {
                let txt = window.getSelection().toString(); // kind of a hack, but the following 'correct' way doesn't work: event.clipboardData.getData("text");
                Logger.log("Cut", "raw_text:"+txt);
            });
            cm.on('paste', function(cm, event) {
                let items = event.clipboardData.items;
                // Support for pasting an image:
                if (items.length > 1 && items[1]["kind"] === "file" && items[1]["type"].includes("image/")) {

                    let imageBlob = items[1].getAsFile();
                    let canvas = create_canvas(600, 340);

                    Logger.log("Pasted", "image_from_clipboard");

                    // Create NotateCanvas and attach event handlers
                    let notate_canvas = NotateCanvasManager.setup(canvas);

                    // Crossbrowser support for URL
                    let URLObj = window.URL || window.webkitURL;

                    // Creates a DOMString containing a URL representing the object given in the parameter
                    // namely the original Blob
                    notate_canvas.loadFromDataURL(URLObj.createObjectURL(imageBlob));

                    // Insert canvas at cursor position in current cell
                    let c = insert_canvas_at_cursor(cm, canvas);

                    // Index canvas for future reference
                    canvases[c.idx] = notate_canvas;
                    notate_canvas.idx = c.idx;
                    notate_canvas.cell = cell;
                }
                let txt = event.clipboardData.getData("text");
                console.log("pasted!", txt);
                Logger.log("Pasted", "raw_text:"+txt);
                just_pasted = txt;
            });
        };


        // Add event handlers to all preloaded cells
        code_cells.forEach(attachCanvasEventHandlers);

        // Intercept cell creation to add event handlers
        $([IPython.events]).on("create.Cell", function(evt, data) {
            attachCanvasEventHandlers(data["cell"]);
        });

      }

      // Wait until something is loaded
      // function defer(check, cb) {
      //     if (check()) {
      //         cb();
      //     } else {
      //         setTimeout(function() { defer(check, cb); }, 50);
      //     }
      // }

      // This function is called when a notebook is started.
      function load_ipython_extension() {

        // Load Spectrum JS color selector library CSS file.
        $('<link>')
            .attr({
                rel: 'stylesheet',
                type: 'text/css',
                href: requirejs.toUrl('./libs/spectrum.min.css')
            })
            .appendTo('head');

        initialize();
      }

      return {
        load_ipython_extension: load_ipython_extension
      };
});

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
        c.loadFromDataURL(this.toDataURL(), true, true);
        return c;
    }
    constructor(canvas_element) {
        this.strokes = [];
        this.idx = null; // undefined
        this.cell = null;
        this.stateStack = [];
        this.stateIdx = -1;
        this.canvas = canvas_element;
        this.ctx = this.canvas.getContext('2d', {
            desynchronized: false
        });
        this.ctx.imageSmoothingEnabled = true; // anti-aliasing
        this.CHANGESIZE_DIALOG_ENABLED = false;

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

        // Resize parameters
        this.default_resize_thresh = 20;
        this.resize_thresh = 20;
        this.default_resize_settings = Object.freeze({
            'right': {
                'cursor': 'col-resize',
                'borderRight': '3px solid gray',
                'borderBottom': hover_border
            },
            'bot': {
                'cursor': 'row-resize',
                'borderRight': hover_border,
                'borderBottom': '3px solid gray'
            },
            'botright': {
                'cursor': 'nwse-resize',
                'borderRight': '3px solid gray',
                'borderBottom': '3px solid gray'
            },
            'default': {
                'border': hover_border,
                'cursor': 'auto'
            }
        });
        this.resize_settings = this.default_resize_settings;

        this.disable_resize = false;
        this.disable_expand = false;
        this.resizing = false;
        this.pointer_down = false;
        this.pointer_moved = false;
        this.disable_drawing = false;

        this.saved_img = null;
        this._is_dirty = false;
        this._resize_canvas_copy = null;

        this.new_strokes = {};

        // Attach pointer event listeners
        let pointerEnter = function pointerEnter(e) {
            Logger.log(this.getName(), 'pointerenter:'+e.pointerType);
            if (!this.disable_expand)
                this.canvas.style.border = this.resize_settings.default.border;
            if (this.saved_img === null)
                this.saved_img = this.toDataURL();
        }.bind(this);
        let pointerDown = function pointerDown(e) {
            Logger.log(this.getName(), 'pointerdown:'+e.pointerType);
            this.pointer_down = true;
            this.pointer_moved = false;

            if (this.resizing && e.pointerType === "mouse") {
                Logger.log(this.getName(), 'start_resizing:'+e.pointerType+';'+this.canvas.style.width+';'+this.canvas.style.height);

                // create backing canvas
                let backCanvas = document.createElement('canvas');
                backCanvas.width = this.canvas.width;
                backCanvas.height = this.canvas.height;
                backCanvas.getContext('2d').drawImage(this.canvas, 0, 0);
                this._resize_canvas_copy = backCanvas;

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

            // Skip if drawing is disabled
            if (this.disable_drawing) return;

            // Create new stroke and attach reference
            let s = { pts: [this.getPointerValue(e)], weight:this.pen_weight, color:this.pen_color };
            this.new_strokes[e.pointerId] = s;

            Logger.log(this.getName(), 'start_drawing:'+e.pointerType);

            this.drawStroke(s);
        }.bind(this);
        let pointerMove = function pointerMove(e) {
            // Skip if drawing is disabled
            if (this.disable_drawing) return;
            else if (e.pointerType === "touch") return; // disable move events on touch

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
                const d = this.resize_thresh;
                if (this.resizing.includes('hor')) {
                    this.canvas.style.width = Math.floor(e.offsetX + d) + "px";
                    this.canvas.width = Math.floor(e.offsetX + d) * 2;
                }
                if (this.resizing.includes('vert')) {
                    this.canvas.style.height = Math.floor(e.offsetY + d) + "px";
                    this.canvas.height = Math.floor(e.offsetY + d) * 2;
                }

                // After resize, we have to redraw the pre-resize contents of the canvas:
                this.canvas.getContext('2d').drawImage(this._resize_canvas_copy, 0, 0);

            } else if (!this.disable_resize) {
                // Bottom-right resize
                const d = this.resize_thresh;
                if (pos.x >= this.canvas.width - d && pos.y >= this.canvas.height - d) {
                    this.canvas.style.cursor = this.resize_settings.botright.cursor;
                    this.canvas.style.borderRight = this.resize_settings.botright.borderRight;
                    this.canvas.style.borderBottom = this.resize_settings.botright.borderBottom;
                    this.resizing = "hor-vert";
                }
                else if (pos.x >= this.canvas.width - d) {
                    this.canvas.style.cursor = this.resize_settings.right.cursor;
                    this.canvas.style.borderRight = this.resize_settings.right.borderRight;
                    this.canvas.style.borderBottom = this.resize_settings.right.borderBottom;
                    this.resizing = "hor";
                }
                else if (pos.y >= this.canvas.height - d) {
                    this.canvas.style.cursor = this.resize_settings.bot.cursor;
                    this.canvas.style.borderRight = this.resize_settings.bot.borderRight;
                    this.canvas.style.borderBottom = this.resize_settings.bot.borderBottom;
                    this.resizing = "vert";
                }
                else {
                    this.canvas.style.cursor = this.resize_settings.default.cursor;
                    // this.canvas.style.border = "thin solid #aaa";
                    this.canvas.style.border = this.resize_settings.default.border;
                    this.resizing = false;
                }
            }
        }.bind(this);
        let pointerLeave = function pointerLeave(e) {
            if (this.pointer_down) {
                if (this.resizing) {
                    // Continue to resize canvas from bottom-right corner:
                    const d = this.resize_thresh;
                    if (this.resizing.includes('hor')) {
                        this.canvas.style.width = Math.floor(e.offsetX + d) + "px";
                        this.canvas.width = Math.floor(e.offsetX + d) * 2;
                    }
                    if (this.resizing.includes('vert')) {
                        this.canvas.style.height = Math.floor(e.offsetY + d) + "px";
                        this.canvas.height = Math.floor(e.offsetY + d) * 2;
                    }

                    // After resize, we have to redraw the pre-resize contents of the canvas:
                    this.canvas.getContext('2d').drawImage(this._resize_canvas_copy, 0, 0);

                    e.preventDefault();
                }
            }
            else {
                Logger.log(this.getName(), 'pointerleave:'+e.pointerType);
            }
            if (!this.disable_expand)
                this.canvas.style.border = this.resize_settings.default.border;
        }.bind(this);
        let pointerUp = function pointerUp(e) {
            Logger.log(this.getName(), 'pointerup:'+e.pointerType);

            // Skip if drawing is disabled
            if (this.disable_drawing) return;

            if (this.pointer_down) {
                if (this.resizing !== false) { // End of resizing canvas operation.
                    Logger.log(this.getName(), 'finish_resize:'+e.pointerType+';'+this.canvas.style.width+';'+this.canvas.style.height);
                    if (this.pointer_moved) {

                        // After resize, we have to redraw the pre-resize contents of the canvas:
                        this.canvas.getContext('2d').drawImage(this._resize_canvas_copy, 0, 0);

                        this.saved_img = this.toDataURL();
                        this.pushState(this.saved_img);
                        this.saveMetadataToCell(); // Save resized image to cell metadata
                    } else { // Open modal input asking for specific width/height pixel values
                        if (this.CHANGESIZE_DIALOG_ENABLED)
                            this.openChangeSizeDialog();
                    }
                } else if (!this.pointer_moved && !this.disable_expand) { // Clicked the canvas: expand to fullscreen.
                    let _this = this;

                    Logger.log("Fullscreen mode", "entered:"+this.getName());

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
                    bg.style.opacity = 0.4;
                    site.appendChild(bg);

                    // Div wrapper over the DOM canvas:
                    const bounds = this.canvas.getBoundingClientRect();
                    const margin = 100;
                    let scaleX = Math.min((site_bounds.width - margin*2) / bounds.width, (site_bounds.height - 110 - margin*2) / bounds.height);
                    let canvas_wrapper = document.createElement('div');
                    canvas_wrapper.style.position = "absolute";
                    canvas_wrapper.style.display = "block";
                    canvas_wrapper.style.margin = "0";
                    canvas_wrapper.style.padding = "0";
                    canvas_wrapper.style.left = (site_bounds.width/2 - bounds.width/2*scaleX) + "px";
                    canvas_wrapper.style.top  = (site_bounds.height/2 - bounds.height/2*scaleX) + "px";
                    canvas_wrapper.style.width = Math.floor(bounds.width*scaleX) + "px";
                    canvas_wrapper.style.height = Math.floor(bounds.height*scaleX) + "px";
                    canvas_wrapper.style.zIndex = "6";
                    site.append(canvas_wrapper);

                    // The cloned DOM canvas:
                    let clone = this.canvas.cloneNode(false);
                    clone.style.backgroundColor = "#fff";
                    clone.style.position = "inherit";
                    clone.style.display = "block";
                    clone.style.margin = "0";
                    // clone.style.zIndex = "6";
                    clone.style.left = Math.floor(bounds.width*scaleX - bounds.width)/2 + "px";
                    clone.style.top  = Math.floor(bounds.height*scaleX - bounds.height)/2 + "px";
                    clone.style.width = Math.floor(bounds.width) + "px";
                    clone.style.height = Math.floor(bounds.height) + "px";
                    clone.style.transform = "scale(" + scaleX + "," + scaleX + ")";
                    clone.style.border = "none";
                    clone.style.cursor = "crosshair";
                    canvas_wrapper.appendChild(clone);
                    // clone.style.transition = "transform 1000ms cubic-bezier(0.165, 0.84, 0.44, 1)";

                    // Resize settings for fullscreen mode:
                    const fullscreen_resize_settings = Object.freeze({
                        'right': {
                            'cursor': 'col-resize',
                            'borderRight': '1px solid gray',
                            'borderBottom': '0px solid gray'
                        },
                        'bot': {
                            'cursor': 'row-resize',
                            'borderRight': '0px solid gray',
                            'borderBottom': '1px solid gray'
                        },
                        'botright': {
                            'cursor': 'nwse-resize',
                            'borderRight': '1px solid gray',
                            'borderBottom': '1px solid gray'
                        },
                        'default': {
                            'border': '0px',
                            'cursor': 'crosshair'
                        }
                    });

                    // Add pen-based draw capabilities to canvas w/ draw library code:
                    let notate_clone = NotateCanvasManager.setup(clone);
                    notate_clone.bg_opacity = 1.0;
                    // notate_clone.disable_resize = true;
                    // console.log(clone.style.width, scaleX);
                    notate_clone.resize_thresh = 10;
                    notate_clone.resize_settings = fullscreen_resize_settings;
                    notate_clone.disable_expand = true;
                    notate_clone.strokes = this.strokes;
                    notate_clone.setPenColor(this.pen_color);
                    notate_clone.idx = this.idx;
                    notate_clone.cell = this.cell;
                    notate_clone.loadFromDataURL(this.toDataURL(), true, true);

                    let cursorsvg = document.createElementNS("http://www.w3.org/2000/svg", 'svg'); //Create a path in SVG's namespace
                    cursorsvg.style.position = "absolute";
                    cursorsvg.style.display = "block";
                    cursorsvg.style.pointerEvents = "none";
                    cursorsvg.setAttribute("width", "32px");
                    cursorsvg.setAttribute("height", "32px");
                    // cursorsvg.setAttribute("opacity", "0.5");
                    cursorsvg.setAttribute("viewBox", "0 0 32 32");
                    cursorsvg.style.zIndex = "4";
                    cursorsvg.innerHTML += '<circle cx="15" cy="15" r="4" stroke="black" fill="black" stroke-width="0"></circle>';
                    cursorsvg.drag_resize = false; // special attribute when drawing elements like a rect and circle
                    cursorsvg.drag_start = null;
                    cursorsvg.offset = {x:-16, y:-16};
                    canvas_wrapper.appendChild(cursorsvg);

                    const div_to_canvas_coord = function(p) {
                        return { x: p.x/scaleX*2, y: p.y/scaleX*2 }; // notate_clone.resolution
                    };

                    // canvas_wrapper.innerHTML += '<svg height="30" width="30" style="position:absolute;z-index:7"></svg>';

                    // Toolbar icons
                    // == Toolbar button helper functions ==
                    function createIcon(fontAwesomeIconName, tooltip, innerAdj) {
                        let iconbg = document.createElement('div');
                        iconbg.style.position = "absolute";
                        iconbg.style.display = "block";
                        iconbg.style.width = "32px";
                        iconbg.style.height = "32px";
                        iconbg.style.zIndex = "7";
                        iconbg.style.backgroundColor = "#eee";
                        iconbg.title = tooltip;

                        // There isn't actually an icon in FontAwesome that represents
                        // a line, so we manually create it w/ an SVG element:
                        if (fontAwesomeIconName == 'line') {
                            let svg = document.createElementNS("http://www.w3.org/2000/svg", 'svg'); //Create a path in SVG's namespace
                            svg.style.position = "relative";
                            svg.style.display = "block";
                            svg.setAttribute("width", "32px");
                            svg.setAttribute("height", "32px");
                            svg.setAttribute("viewBox", "0 0 32 32");
                            svg.style.zIndex = "8";

                            let path = document.createElement('path');
                            path.setAttribute("d","M 5 27 L 27 5"); //Set path's data
                            path.setAttribute("stroke", "black"); //Set stroke colour
                            path.setAttribute("stroke-width", "2"); //Set stroke width
                            svg.appendChild(path);

                            iconbg.appendChild(svg);

                            // Force a draw of the SVG element. See: https://stackoverflow.com/a/56923928
                            svg.innerHTML += "";

                        } else {
                            let i = document.createElement('i');
                            i.style.position = "relative";
                            i.style.display = "block";
                            i.classList.add("fa")
                            i.classList.add("fa-"+fontAwesomeIconName);
                            i.classList.add("fa-2x");
                            i.style.zIndex = "8";
                            i.style.left = innerAdj[0];
                            i.style.top = innerAdj[1];
                            iconbg.appendChild(i);
                        }

                        iconbg.is_toggled = false; // Special flag
                        return iconbg;
                    }
                    function attachEvents(i, onClickCb) {
                        i.addEventListener('pointerdown', function(e) {
                            onClickCb();
                        }.bind(i));
                        i.addEventListener('pointermove', function(e) {
                            if (e.pointerType !== "touch")
                                this.style.cursor = 'pointer';
                            if (!this.is_toggled) {
                                this.style.color = "white";
                                this.style.backgroundColor = "#aae";
                            } else {
                                this.style.color = "#aae";
                            }
                        }.bind(i));
                        i.addEventListener('pointerleave', function(e) {
                            if (e.pointerType !== "touch")
                                this.style.cursor = 'default';
                            if (!this.is_toggled) {
                                this.style.color = "#000";
                                this.style.backgroundColor = "#eee";
                            } else {
                                this.style.color = "#33a";
                            }
                        }.bind(i));
                        return i;
                    }
                    function toggleIcon(icon, allIcons) {
                        icon.style.backgroundColor = "#88e";
                        icon.style.color = "#33a";
                        icon.is_toggled = true;
                        allIcons.forEach((item, i) => {
                            if (item == icon) return;
                            item.style.backgroundColor = "#eee";
                            item.style.color = "#000";
                            item.is_toggled = false;
                        });
                    }

                    // Toolbar button specification
                    let tool_btns_specs = [
                        ['pencil', "Freeform draw", ["4px", "3px"]],
                        ['square-o', "Rectangle tool", ["6px", "4px"]],
                        ['circle-thin', "Circle tool", ["5px", "3px"]],
                        ['line', "Line tool", ["2px", "3px"]],
                        ['eraser', "Erase", ["2px", "3px"]],
                        ['undo', "Undo", ["4px", "3px"]],
                        ['repeat', "Redo", ["4px", "3px"]],
                        ['trash', "Clear canvas", ["4px", "3px"]]
                    ];
                    // Generate DIV elements for toolbar based on spec
                    let tool_btns = tool_btns_specs.map(function(item, i) {
                        const leftedge = site_bounds.width/2 - bounds.width/2*scaleX;
                        const topedge = site_bounds.height/2 - bounds.height/2*scaleX;
                        let icon = createIcon(item[0], item[1], item[2]);
                        icon.style.left = (leftedge - 40) + "px";
                        icon.style.top = (topedge + 20 + 40*i) + "px";
                        return icon;
                    });

                    // Background for toolbar
                    let bg_toolbar = document.createElement('div');
                    bg_toolbar.style.position = "absolute";
                    bg_toolbar.style.display = "block";
                    bg_toolbar.style.width = "48px";
                    bg_toolbar.style.height = (18 + 40*tool_btns.length) + "px";
                    bg_toolbar.style.borderRadius = "8px 0px 0px 8px";
                    bg_toolbar.style.backgroundColor = "#eee";
                    bg_toolbar.style.zIndex = "6";

                    site.appendChild(bg_toolbar);
                    tool_btns.forEach((icon, i) => {
                        site.appendChild(icon);
                    });

                    let reposition_toolbar = function() {
                        const leftedge = parseInt(canvas_wrapper.style.left.substring(0, canvas_wrapper.style.left.length-2));
                        const topedge = parseInt(canvas_wrapper.style.top.substring(0, canvas_wrapper.style.top.length-2));
                        bg_toolbar.style.left = (leftedge - 48) + "px";
                        bg_toolbar.style.top = (topedge + 8) + "px";
                        tool_btns.forEach(function(icon, i) {
                            icon.style.left = (leftedge - 40) + "px";
                            icon.style.top = (topedge + 20 + 40*i) + "px";
                        });
                    };
                    reposition_toolbar();

                    // Toggle the pencil icon on by default:
                    toggleIcon(tool_btns[0], tool_btns);

                    // Spectrum.js library color picker
                    // let color_picker = $('<input id="color-picker" value="' + this.getPenColor() + '" />');
                    // $("body").append(color_picker);
                    // $(color_picker).spectrum({
                    //     type: "color",
                    //     change: function(clr) {
                    //         notate_clone.setPenColor(clr);
                    //         _this.setPenColor(clr);
                    //     }
                    // });
                    // $(".sp-replacer").css({
                    //     "position": "absolute",
                    //     "display": "block",
                    //     "left": (leftedge - 40) + "px",
                    //     "top": (topedge + 60) + "px",
                    //     "z-index": "7"
                    // });
                    // $(color_picker).click(function(evt) {
                    //   evt.stopPropagation();
                    // });
                    // $(color_picker).keydown(function(evt) {
                    //   evt.stopPropagation();
                    // });

                    // Pointer events for the invisible div that wraps the canvas:
                    // this handles changing and moving the overlay svg
                    let was_resizing = false;
                    canvas_wrapper.addEventListener('pointerdown', function(e) {
                        if (cursorsvg.drag_resize) {
                            Logger.log("Fullscreen mode", "drag_tool:pointerdown:" + e.pointerType);
                            cursorsvg.drag_start = { x: Math.floor(e.offsetX*scaleX) + cursorsvg.offset.x, y: Math.floor(e.offsetY*scaleX) + cursorsvg.offset.y };
                            cursorsvg.style.left = e.offsetX*scaleX + cursorsvg.offset.x;
                            cursorsvg.style.top = e.offsetY*scaleX + cursorsvg.offset.y;
                        }
                    });
                    canvas_wrapper.addEventListener('pointermove', function(e) {
                        if (cursorsvg.drag_resize && cursorsvg.drag_start) {
                            // Logger.log("Fullscreen mode", "drag_tool:pointermove:" + e.pointerType);

                            // Resize svg to fit box made from start point to end point:
                            const shape = cursorsvg.firstChild.tagName;
                            let w = e.offsetX*scaleX - cursorsvg.drag_start.x;
                            let h = e.offsetY*scaleX - cursorsvg.drag_start.y;
                            cursorsvg.setAttribute("width", Math.max(3,Math.abs(w)) + "px");
                            cursorsvg.setAttribute("height", Math.max(3,Math.abs(h)) + "px");
                            if (w < 0) cursorsvg.style.left = e.offsetX*scaleX + cursorsvg.offset.x;
                            else       cursorsvg.style.left = cursorsvg.drag_start.x;
                            if (h < 0) cursorsvg.style.top = e.offsetY*scaleX + cursorsvg.offset.y;
                            else       cursorsvg.style.top = cursorsvg.drag_start.y;
                            cursorsvg.setAttribute("viewBox", "0 0 " + Math.max(3,Math.abs(w)) + " " + Math.max(3,Math.abs(h)));

                            if (shape == 'line') {
                                if (h < 0 && w >= 0) {
                                    cursorsvg.firstChild.setAttribute('y1', "100%");
                                    cursorsvg.firstChild.setAttribute('y2', "0");
                                    cursorsvg.firstChild.setAttribute('x1', "0");
                                    cursorsvg.firstChild.setAttribute('x2', "100%");
                                } else if (h >= 0 && w < 0) {
                                    cursorsvg.firstChild.setAttribute('x1', "100%");
                                    cursorsvg.firstChild.setAttribute('x2', "0");
                                    cursorsvg.firstChild.setAttribute('y1', "0");
                                    cursorsvg.firstChild.setAttribute('y2', "100%");
                                } else {
                                    cursorsvg.firstChild.setAttribute('x1', "0");
                                    cursorsvg.firstChild.setAttribute('x2', "100%");
                                    cursorsvg.firstChild.setAttribute('y1', "0");
                                    cursorsvg.firstChild.setAttribute('y2', "100%");
                                }
                            }

                            // cursorsvg.firstChild.setAttribute("width", w + "px");
                            // cursorsvg.firstChild.setAttribute("height", h + "px");
                            cursorsvg.innerHTML += "";
                            // cursorsvg.drag_end = [e.offsetX*scaleX, e.offsetY*scaleX];
                        } else if (notate_clone.resizing !== false) {
                            // Logger.log("Fullscreen mode", "resize_canvas:pointermove:" + e.pointerType);
                            cursorsvg.style.display = "none";
                            if (notate_clone.pointer_down)
                                was_resizing = true;
                        } else {
                            if (cursorsvg.style.display != "block")
                                cursorsvg.style.display = "block";
                            cursorsvg.style.left = e.offsetX*scaleX + cursorsvg.offset.x;
                            cursorsvg.style.top = e.offsetY*scaleX + cursorsvg.offset.y;
                            was_resizing = false;
                        }
                    });
                    canvas_wrapper.addEventListener('pointerup', function(e) {
                        if (was_resizing) {
                            Logger.log("Fullscreen mode", "resize_canvas:pointerup:" + e.pointerType);
                            // ScaleX shouldn't actually change on a resize operation --what changes is the left and top values.
                            // canvas_wrapper.style.backgroundColor = 'red';
                            canvas_wrapper.style.width = Math.floor(notate_clone.canvas.width/2*scaleX) + "px";
                            canvas_wrapper.style.height = Math.floor(notate_clone.canvas.height/2*scaleX) + "px";
                            // complicated realignment bc of scale()
                            canvas_wrapper.style.left = (site_bounds.width/2 - clone.width/4*scaleX) + Math.floor(clone.width/2 - bounds.width)/2 + 'px'; // + Math.floor(clone.width/2*scaleX - bounds.width)/2 + "px";
                            canvas_wrapper.style.top  = (site_bounds.height/2 - clone.height/4*scaleX) + Math.floor(clone.height/2 - bounds.height)/2 + "px";
                            clone.style.left = Math.floor(clone.width/2*scaleX - bounds.width)/2 - Math.floor(clone.width/2 - bounds.width)/2 + "px";
                            clone.style.top  = Math.floor(clone.height/2*scaleX - bounds.height)/2 - Math.floor(clone.height/2 - bounds.height)/2 + "px";
                            // console.log(bounds.width, Math.floor(clone.width/2 - bounds.width)/2, clone.style.left, canvas_wrapper.style.left);
                            reposition_toolbar();
                            was_resizing = false;
                        }
                        else if (cursorsvg.drag_resize && cursorsvg.drag_start) {
                            Logger.log("Fullscreen mode", "drag_tool:pointerup:" + e.pointerType);

                            // Commit the dragged shape to canvas:
                            // 1. Generate strokes that match the dragged shape
                            let stroke;
                            const shape = cursorsvg.firstChild.tagName;
                            if (shape == 'rect') { // Rectangle
                                const topleft  = div_to_canvas_coord(cursorsvg.drag_start);
                                const topright = div_to_canvas_coord({x: e.offsetX*scaleX, y: cursorsvg.drag_start.y });
                                const botleft  = div_to_canvas_coord({x: cursorsvg.drag_start.x, y: e.offsetY*scaleX });
                                const botright = div_to_canvas_coord({x: e.offsetX*scaleX, y: e.offsetY*scaleX });
                                stroke     = { pts: [topleft, topright, botright, botleft, topleft],
                                            weight:4,
                                             color:notate_clone.pen_color };
                            } else if (shape == 'ellipse') { // Circle (ellipse)
                                const weight = 4;
                                const w = e.offsetX*scaleX - cursorsvg.drag_start.x - weight;
                                const h = e.offsetY*scaleX - cursorsvg.drag_start.y - weight;
                                const center = { x:(e.offsetX*scaleX+cursorsvg.drag_start.x)/2,
                                                 y:(e.offsetY*scaleX+cursorsvg.drag_start.y)/2 };
                                const segs = 32.0;
                                const pi2 = Math.PI * 2;
                                let pts = [];
                                for (let i = 0; i <= segs; i++) { // Generate the points on a circle
                                    pts.push( {x: center.x + w/2*Math.cos(i/segs*pi2),
                                               y: center.y + h/2*Math.sin(i/segs*pi2) } );
                                }
                                stroke = { pts: pts.map(div_to_canvas_coord), weight: 4, color: notate_clone.pen_color };
                            } else { // Line
                                const endpt = {x: e.offsetX*scaleX, y: e.offsetY*scaleX};
                                stroke = { pts: [div_to_canvas_coord(cursorsvg.drag_start), div_to_canvas_coord(endpt)],
                                        weight: 4, color: notate_clone.pen_color};
                                console.log(stroke.pts);
                            }

                            // 2. Commit the shape's strokes to canvas
                            if (notate_clone.stateStack.length === 0)
                                notate_clone.pushState();
                            notate_clone.drawStroke(stroke);
                            notate_clone.pushState();

                            // 3. Reset the dragging box
                            cursorsvg.drag_start = null;
                            cursorsvg.setAttribute("width", "16px");
                            cursorsvg.setAttribute("height", "16px");
                            cursorsvg.setAttribute("viewBox", "0 0 16 16");
                            cursorsvg.style.left = e.offsetX*scaleX + cursorsvg.offset.x;
                            cursorsvg.style.top = e.offsetY*scaleX + cursorsvg.offset.y;
                        }
                    });
                    canvas_wrapper.addEventListener('pointerenter', function(e) {
                        cursorsvg.style.display = "inline";
                    });
                    canvas_wrapper.addEventListener('pointerleave', function(e) {
                        cursorsvg.style.display = "none";
                    });

                    // Event handlers for toggling toolbar buttons
                    attachEvents(tool_btns[0], function() { // Pencil
                        Logger.log("Toolbar", "toggled:pencil");
                        notate_clone.setPenColor('#000');
                        notate_clone.setPenWeight(2);
                        notate_clone.disable_drawing = false;
                        cursorsvg.setAttribute("width", "32px");
                        cursorsvg.setAttribute("height", "32px");
                        cursorsvg.setAttribute("viewBox", "0 0 32 32");
                        cursorsvg.offset = {x: -16, y: -16};
                        cursorsvg.innerHTML = '<circle cx="15" cy="15" r="4" stroke="black" fill="black" stroke-width="0"></circle>';
                        cursorsvg.drag_resize = false;
                        toggleIcon(tool_btns[0], tool_btns);
                    });
                    attachEvents(tool_btns[1], function() { // Rectangle tool
                        Logger.log("Toolbar", "toggled:rect");
                        notate_clone.setPenColor('#000');
                        notate_clone.setPenWeight(2);
                        notate_clone.disable_drawing = true; // disable direct pen drawing mode
                        cursorsvg.setAttribute("width", "16px");
                        cursorsvg.setAttribute("height", "16px");
                        cursorsvg.setAttribute("viewBox", "0 0 16 16");
                        cursorsvg.offset = {x: 0, y: 0};
                        cursorsvg.innerHTML = '<rect width="100%" height="100%" stroke="black" opacity="0.6" fill="none" stroke-width="4px"></rect>';
                        cursorsvg.drag_resize = true;
                        toggleIcon(tool_btns[1], tool_btns);
                    });
                    attachEvents(tool_btns[2], function() { // Circle tool
                        Logger.log("Toolbar", "toggled:circle");
                        notate_clone.setPenColor('#000');
                        notate_clone.setPenWeight(2);
                        notate_clone.disable_drawing = true; // disable direct pen drawing mode
                        cursorsvg.setAttribute("width", "16px");
                        cursorsvg.setAttribute("height", "16px");
                        cursorsvg.setAttribute("viewBox", "0 0 16 16");
                        cursorsvg.offset = {x: 0, y: 0};
                        cursorsvg.innerHTML = '<ellipse cx="50%" cy="50%" rx="49%" ry="49%" stroke="black" opacity="0.6" fill="none" stroke-width="2px"></ellipse>';
                        cursorsvg.drag_resize = true;
                        toggleIcon(tool_btns[2], tool_btns);
                    });
                    attachEvents(tool_btns[3], function() { // Line tool
                        Logger.log("Toolbar", "toggled:line");
                        notate_clone.setPenColor('#000');
                        notate_clone.setPenWeight(2);
                        notate_clone.disable_drawing = true; // disable direct pen drawing mode
                        cursorsvg.setAttribute("width", "16px");
                        cursorsvg.setAttribute("height", "16px");
                        cursorsvg.setAttribute("viewBox", "0 0 16 16");
                        cursorsvg.offset = {x: 0, y: 0};
                        cursorsvg.innerHTML = '<line x1="0" y1="0" x2="100%" y2="100%" stroke="black" opacity="0.6" fill="none" stroke-width="4px"></line>';
                        cursorsvg.drag_resize = true;
                        toggleIcon(tool_btns[3], tool_btns);
                    });
                    attachEvents(tool_btns[4], function() { // Eraser
                        Logger.log("Toolbar", "toggled:eraser");
                        notate_clone.setPenColor('erase'); // erase is a special setting
                        notate_clone.setPenWeight(6);
                        notate_clone.disable_drawing = false;
                        cursorsvg.setAttribute("width", "32px");
                        cursorsvg.setAttribute("height", "32px");
                        cursorsvg.setAttribute("viewBox", "0 0 32 32");
                        cursorsvg.offset = {x: -16, y: -16};
                        cursorsvg.innerHTML = '<circle cx="15" cy="15" r="6" stroke="black" fill="none" stroke-width="1"></circle>';
                        cursorsvg.drag_resize = false;
                        toggleIcon(tool_btns[4], tool_btns);
                    });
                    attachEvents(tool_btns[5], function() { // Undo
                        Logger.log("Toolbar", "toggled:undo");

                        // UNDO --SPECIAL CODE HERE
                        notate_clone.revertState();
                        // if (notate_clone.stateIdx <= 0) {
                        //     tool_btns[5].style.color = "gray";
                        //     tool_btns[5].disabled = true;
                        // }
                    });
                    attachEvents(tool_btns[6], function() { // Redo
                        Logger.log("Toolbar", "toggled:redo");

                        // REDO --SPECIAL CODE HERE
                        notate_clone.advanceState();
                    });
                    attachEvents(tool_btns[7], function() { // Trash
                        Logger.log("Toolbar", "toggled:trash");

                        notate_clone.strokes = [];
                        notate_clone.clear();
                    });


                    // Exit modal popover when clicking/touching off the canvas:
                    bg.addEventListener('pointerdown', function(e) {
                        //if (e.pointerType === "pen") return;

                        Logger.log("Fullscreen mode", "exiting:"+e.pointerType);

                        // Transfer strokes back to the parent canvas:
                        this.strokes = notate_clone.strokes;
                        const cloneDataURL = notate_clone.toDataURL();

                        // Remove modal elements:
                        site.removeChild(bg);
                        canvas_wrapper.removeChild(clone);
                        site.removeChild(canvas_wrapper);
                        site.removeChild(bg_toolbar);
                        // $(color_picker).spectrum("destroy");
                        // color_picker.remove();
                        tool_btns.forEach((icon, i) => {
                            site.removeChild(icon);
                        });
                        NotateCanvasManager.remove(notate_clone);

                        // Update parent canvas:
                        this.clear();
                        this.loadFromDataURL(cloneDataURL);
                        this.stateStack = [];
                        this.stateIdx = -1;
                        // this.draw();
                    }.bind(this));
                    bg.addEventListener('pointerenter', function(e) {
                        //if (e.pointerType === "pen") return;

                        Logger.log("Fullscreen bg", "pointerenter:" + e.pointerType);

                        notate_clone.canvas.style.opacity = 0.5;
                        bg.style.opacity = 0.2;
                        cursorsvg.style.display = "none";

                    }.bind(this));
                    bg.addEventListener('pointerleave', function(e) {
                        //if (e.pointerType === "pen") return;

                        Logger.log("Fullscreen bg", "pointerleave:" + e.pointerType);

                        // For some reason the canvas element doesn't redraw on some platforms if opacity is set to 1.0.
                        // So I first set it to 0.99 to force the DOM redraw.
                        notate_clone.canvas.style.opacity = 0.99;
                        bg.style.opacity = 0.4;
                        cursorsvg.style.display = "inline";
                        // notate_clone.canvas.style.opacity = 1.0;

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
                Logger.log(this.getName(), 'finish_drawing:'+e.pointerType);

                // Move stroke into the main strokes array:
                this.strokes.push( this.new_strokes[e.pointerId] );
                delete this.new_strokes[e.pointerId];

                // Push canvas state onto undo stack
                this.pushState();

                // Save img contents of canvas to Jupyter cell metadata
                this.saveMetadataToCell();

                // Update backend if defined:
                if (this.socket) {
                    this.socket.sendDrawing(this.strokes, this.canvas.id);
                }
            } else {
                this.canvas.style.border = this.resize_settings.default.border;
                this.canvas.style.cursor = this.resize_settings.default.cursor;
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
    loadFromDataURL(dataURL, changeSize=true, pushState=false) {
        this._is_dirty = true;
        let _this = this;
        return new Promise(function (resolve, reject) {
            let img = new Image();
            let canvas = _this.canvas;
            img.addEventListener("load", function () {
                if (changeSize) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    canvas.style.width = img.width/2+"px";
                    canvas.style.height = img.height/2+"px";
                }
                canvas.getContext("2d").drawImage(img, 0, 0);
                _this._is_dirty = false;
                resolve();
            });
            if (pushState)
                _this.pushState(dataURL);
            img.setAttribute("src", dataURL);
        });
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
    getName() { return 'canvas:' + (this.idx ? this.idx : "(undefined)"); }
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
    getPenColor() {
        if (this.pen_color === 'erase') return "#000000";
        else return this.pen_color;
    }
    setPenWeight(weight) {
        this.pen_weight = weight;
    }
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Push the cleared state onto the undo stack
        this.pushState();
        // if (this.bg_color) { // Draw background if set.
        //     const gl_a = this.ctx.globalAlpha;
        //     if (this.bg_opacity < 1.0) this.ctx.globalAlpha = this.bg_opacity;
        //     this.ctx.fillStyle = this.bg_color;
        //     this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        //     if (this.bg_opacity < 1.0) this.ctx.globalAlpha = gl_a;
        // }
    }

    // Undo / redo stack
    pushState(dataURL=null) {
        // Chop states after the previous index:
        if (this.stateIdx < this.stateStack.length-1)
            this.stateStack.splice(this.stateIdx+1);
        // Push the current canvas state to the undo stack,
        // and set the index to the end of the stack:
        let url = dataURL ? dataURL : this.toDataURL();
        this.stateStack.push(url);
        this.stateIdx = this.stateStack.length-1;
    }
    advanceState() {
        // Check if the stack exists, and we can advance:
        if (this.stateStack.length === 0 || this.stateIdx >= this.stateStack.length-1)
            return;

        // Advance forward one state
        this.stateIdx += 1;
        this.loadFromDataURL(this.stateStack[this.stateIdx]);
    }
    revertState() {
        // Check if the stack exists:
        if (this.stateStack.length === 0 || this.stateIdx <= 0)
            return;

        // Revert back one state, while leaving the
        // stateStack untouched in case the user presses Redo:
        this.stateIdx -= 1;
        this.loadFromDataURL(this.stateStack[this.stateIdx]);
    }

    // Drawing to the canvas
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

    openChangeSizeDialog() {
        let _this = this;
        const MAX_WIDTH = 1440;
        const MAX_HEIGHT = 900;
        $('<form>Width: <input type="text" style="z-index:10000" name="width"> px<br><br>Height: <input type="text" style="z-index:10000" name="height"> px<br></form>').dialog({
          modal: true,
          open: function(evt, ui) {
            // We have to stop the keypresses from bubbling up to Jupyter listeners
            $('input[name="width"]').keydown(function(evt) {
              evt.stopPropagation();
            });
            $('input[name="height"]').keydown(function(evt) {
              evt.stopPropagation();
            });
          },
          close: function() {
            $(this).remove();
          },
          buttons: {
            'OK': function () {
              let width = Number.parseInt($('input[name="width"]').val());
              let height = Number.parseInt($('input[name="height"]').val());
              if (!Number.isNaN(width) && !Number.isNaN(height) && width > 0 && height > 0) {
                console.log("Entered new size for canvas:", width, "by", height);
                if (width > MAX_WIDTH) {
                  width = MAX_WIDTH;
                  console.warn("Entered width exceeds MAX_WIDTH. Capping at", MAX_WIDTH);
                }
                if (height > MAX_HEIGHT) {
                  height = MAX_HEIGHT;
                  console.warn("Entered height exceeds MAX_WIDTH. Capping at", MAX_HEIGHT);
                }
                _this.canvas.style.width = Math.floor(width) + "px";
                _this.canvas.width = Math.floor(width) * 2;
                _this.canvas.style.height = Math.floor(height) + "px";
                _this.canvas.height = Math.floor(height) * 2;
                _this.loadFromDataURL(_this.saved_img, false);
                _this.saveMetadataToCell(); // Save resized image to cell metadata
              } else console.error("Entered value is not a positive integer.", width, height)
              $(this).dialog('close');
              $(this).remove();
            },
            'Cancel': function () {
              $(this).dialog('close');
              $(this).remove();
            }
          }
        });
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


// ========= END MAIN; HELPER SCRIPT BELOW =============
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
