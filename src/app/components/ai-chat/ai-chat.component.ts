import { Component, ElementRef, OnInit, ViewChild, inject, signal, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GoogleGenAI, Type } from '@google/genai';
import { IndexedDbService, ChatThread, ChatMessage } from '../../services/indexed-db.service';
import { CanvasInteractionService } from '../../services/canvas-interaction.service';

export interface ModelInfo {
  id: string;
  name: string;
}

const helloWorldDeclaration: any = {
  name: 'helloWorld',
  description: 'Returns a greetings message "Hello, World!" to the user. Use this when the user asks for a greeting or asks you to run a hello world tool.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'Optional name of the user to greet.'
      }
    }
  }
};

const getLayersDeclaration: any = {
  name: 'getLayers',
  description: 'Retrieve the list of all active layers on the canvas, including their names, types, visual styles, and geometry coordinates (in pixels).',
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

const addPolygonsDeclaration: any = {
  name: 'addPolygons',
  description: 'Add one or more polygons to the canvas. Specify coordinates in pixels or normalized to a 1000x1000 grid of the image size.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      coordinateSystem: { type: Type.STRING, description: 'The coordinate system used: "pixels" (absolute pixel coordinates) or "normalized" (values from 0 to 1000 relative to image dimensions).' },
      polygons: {
        type: Type.ARRAY,
        description: 'The list of polygons to add.',
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: 'The name or label of the polygon (e.g. "Room 1", "Dove Icon").' },
            points: {
              type: Type.ARRAY,
              description: 'The list of points defining the polygon vertices. Specify as a flat list of alternating coordinates: [x1, y1, x2, y2, x3, y3, ...] where X is the horizontal coordinate (0 = left, 1000 = right) and Y is the vertical coordinate (0 = top, 1000 = bottom). DO NOT swap X and Y.',
              items: {
                type: Type.NUMBER
              }
            },
            stroke: { type: Type.STRING, description: 'Optional border hex color (e.g. "#4f46e5").' },
            fill: { type: Type.STRING, description: 'Optional background color in hex or rgba format (e.g. "rgba(129, 140, 248, 0.2)").' },
            strokeWidth: { type: Type.NUMBER, description: 'Optional border thickness.' }
          },
          required: ['points']
        }
      }
    },
    required: ['polygons']
  }
};

const deleteLayersDeclaration: any = {
  name: 'deleteLayers',
  description: 'Delete layers at the specified indices from the canvas. Retrieve indices first using getLayers.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      indices: {
        type: Type.ARRAY,
        description: 'The indices of the layers to delete.',
        items: {
          type: Type.INTEGER
        }
      }
    },
    required: ['indices']
  }
};

const clearLayersDeclaration: any = {
  name: 'clearLayers',
  description: 'Clear all layers from the canvas.',
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

@Component({
  selector: 'app-ai-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-chat.component.html',
})
export class AiChatComponent implements OnInit {
  private readonly dbService = inject(IndexedDbService);
  private readonly canvasService = inject(CanvasInteractionService);

  // Inputs bound to the active workspace state
  readonly imageSrc = input<string | null>(null);
  readonly imageMetadata = input<{ name: string; width: number; height: number; size: string } | null>(null);
  readonly layers = input<any[]>([]);

  @ViewChild('scrollContainer') private scrollContainer?: ElementRef;

  // Signals for state management
  protected readonly apiKey = signal<string | null>(null);
  protected readonly isConfiguringKey = signal<boolean>(false);
  protected readonly threads = signal<ChatThread[]>([]);
  protected readonly activeThread = signal<ChatThread | null>(null);
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly isGenerating = signal<boolean>(false);
  protected readonly availableModels = signal<ModelInfo[]>([]);
  protected readonly isLoadingModels = signal<boolean>(false);
  protected readonly selectedToolDetails = signal<{ name: string; args: any; response: any; error?: string } | null>(null);

  // Form bindings
  protected apiKeyInput = '';
  protected userMessageText = '';
  protected useGridOverlay = true;

  // Gemini AI client instance
  private aiClient: GoogleGenAI | null = null;

  async ngOnInit(): Promise<void> {
    // 1. Load API Key
    const savedKey = await this.dbService.getApiKey();
    if (savedKey) {
      this.apiKey.set(savedKey);
      this.apiKeyInput = savedKey;
      this.initGenAI(savedKey);
      // Load available models and threads
      await this.fetchModels();
      await this.loadThreads();
    } else {
      this.isConfiguringKey.set(true);
    }
  }

  private initGenAI(key: string): void {
    try {
      this.aiClient = new GoogleGenAI({ apiKey: key });
    } catch (err) {
      console.error('Failed to initialize Google Gen AI client', err);
    }
  }

  protected async saveApiKey(): Promise<void> {
    const key = this.apiKeyInput.trim();
    if (!key) return;

    try {
      await this.dbService.saveApiKey(key);
      this.apiKey.set(key);
      this.initGenAI(key);
      this.isConfiguringKey.set(false);
      await this.fetchModels();
      await this.loadThreads();
    } catch (err) {
      console.error('Failed to save API key', err);
      alert('Failed to save API key to local storage.');
    }
  }

  protected async deleteApiKey(): Promise<void> {
    if (confirm('Are you sure you want to delete your API key? This will clear it from your device.')) {
      try {
        await this.dbService.deleteApiKey();
        this.apiKey.set(null);
        this.apiKeyInput = '';
        this.aiClient = null;
        this.isConfiguringKey.set(true);
        this.threads.set([]);
        this.activeThread.set(null);
        this.messages.set([]);
      } catch (err) {
        console.error('Failed to delete API key', err);
      }
    }
  }

  protected async loadThreads(): Promise<void> {
    try {
      const list = await this.dbService.getThreads();
      this.threads.set(list);
    } catch (err) {
      console.error('Failed to load chat threads', err);
    }
  }

  protected async createNewThread(): Promise<void> {
    const threadId = 'thread_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Choose the first available model or fallback to gemini-2.5-flash
    const defaultModel = this.availableModels()[0]?.id || 'models/gemini-2.5-flash';
    
    const newThread: ChatThread = {
      id: threadId,
      title: 'New Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: defaultModel,
    };

    try {
      await this.dbService.saveThread(newThread);
      await this.loadThreads();
      this.selectThread(newThread);
    } catch (err) {
      console.error('Failed to create thread', err);
    }
  }

  protected async selectThread(thread: ChatThread): Promise<void> {
    const available = this.availableModels().map(m => m.id);
    const defaultModel = available[0] || 'models/gemini-2.5-flash';
    
    // If the thread model is missing or not in the available models, migrate it
    if (!thread.model || !available.includes(thread.model)) {
      thread.model = defaultModel;
      await this.dbService.saveThread(thread);
    }

    this.activeThread.set(thread);
    this.messages.set([]);
    this.userMessageText = '';
    
    try {
      const list = await this.dbService.getMessages(thread.id);
      this.messages.set(list);
      this.scrollToBottom();
    } catch (err) {
      console.error('Failed to load messages for thread', err);
    }
  }

  protected async deleteThread(event: Event, threadId: string): Promise<void> {
    event.stopPropagation();
    if (confirm('Are you sure you want to delete this conversation?')) {
      try {
        await this.dbService.deleteThread(threadId);
        await this.loadThreads();
        if (this.activeThread()?.id === threadId) {
          this.activeThread.set(null);
          this.messages.set([]);
        }
      } catch (err) {
        console.error('Failed to delete thread', err);
      }
    }
  }

  private generateGridImage(imageSrcVal: string): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(imageSrcVal);
          return;
        }

        // Draw original image
        ctx.drawImage(img, 0, 0);

        const w = img.naturalWidth;
        const h = img.naturalHeight;

        // Visual grid style
        ctx.lineWidth = 1;
        ctx.font = `${Math.max(10, Math.round(Math.min(w, h) * 0.015))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw vertical grid lines and labels
        for (let i = 1; i < 10; i++) {
          const pct = i / 10;
          const x = w * pct;
          const label = (i * 100).toString();

          // Black line shadow for visibility
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.beginPath();
          ctx.moveTo(x - 1, 0);
          ctx.lineTo(x - 1, h);
          ctx.stroke();

          // Green grid line
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();

          // Labels (Top and Bottom)
          ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.fillText(label, x + 1, Math.round(h * 0.02) + 1);
          ctx.fillText(label, x + 1, Math.round(h * 0.98) + 1);
          
          ctx.fillStyle = '#22c55e';
          ctx.fillText(label, x, Math.round(h * 0.02));
          ctx.fillText(label, x, Math.round(h * 0.98));
        }

        // Draw horizontal grid lines and labels
        for (let i = 1; i < 10; i++) {
          const pct = i / 10;
          const y = h * pct;
          const label = (i * 100).toString();

          // Black line shadow for visibility
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.beginPath();
          ctx.moveTo(0, y - 1);
          ctx.lineTo(w, y - 1);
          ctx.stroke();

          // Green grid line
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();

          // Labels (Left and Right)
          ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.fillText(label, Math.round(w * 0.03) + 1, y + 1);
          ctx.fillText(label, Math.round(w * 0.97) + 1, y + 1);

          ctx.fillStyle = '#22c55e';
          ctx.fillText(label, Math.round(w * 0.03), y);
          ctx.fillText(label, Math.round(w * 0.97), y);
        }

        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        resolve(imageSrcVal);
      };
      img.src = imageSrcVal;
    });
  }

  protected async sendMessage(): Promise<void> {
    const text = this.userMessageText.trim();
    const thread = this.activeThread();
    if (!text || !thread || !this.aiClient) return;

    this.userMessageText = '';
    this.isGenerating.set(true);

    const userMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const userMsg: ChatMessage = {
      id: userMsgId,
      threadId: thread.id,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      parts: [{ text: text }]
    };

    // Save and display user message immediately
    try {
      await this.dbService.saveMessage(userMsg);
      this.messages.update(prev => [...prev, userMsg]);
      this.scrollToBottom();

      // If it was the first message in "New Conversation", update thread title to match user query (shortened)
      if (thread.title === 'New Conversation') {
        const titleLength = 30;
        const newTitle = text.length > titleLength ? text.substring(0, titleLength) + '...' : text;
        thread.title = newTitle;
      }
      
      thread.updatedAt = Date.now();
      await this.dbService.saveThread(thread);
      await this.loadThreads();
    } catch (err) {
      console.error('Failed to save user message', err);
      this.isGenerating.set(false);
      return;
    }

    // Extract active image inlineData base64 if present
    const imageSrcVal = this.imageSrc();
    let imagePart: any = null;
    if (imageSrcVal) {
      const processedImageSrc = this.useGridOverlay 
        ? await this.generateGridImage(imageSrcVal) 
        : imageSrcVal;

      const match = processedImageSrc.match(/^data:(image\/[a-zA-Z+-]+);base64,(.+)$/);
      if (match) {
        imagePart = {
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        };
      }
    }

    // Call Gemini API with Tool Loop
    try {
      let runModelLoop = true;
      let loopCount = 0;
      const maxLoops = 5; // Prevent infinite loops

      while (runModelLoop && loopCount < maxLoops) {
        loopCount++;

        // Map history to Google Gen AI Part structure
        const contents = this.messages().map(msg => {
          let parts: any[] = [];
          
          if (msg.parts && msg.parts.length > 0) {
            // Re-map parts to ensure functionCall and functionResponse match clean structures
            // while preserving sibling metadata fields like thought and thoughtSignature.
            parts = msg.parts.map((p: any) => {
              if (p.functionCall) {
                const cleanCall: any = {
                  name: p.functionCall.name,
                  args: p.functionCall.args
                };
                if (p.functionCall.id) {
                  cleanCall.id = p.functionCall.id;
                }
                return {
                  ...p,
                  functionCall: cleanCall
                };
              } else if (p.functionResponse) {
                const cleanResp: any = {
                  name: p.functionResponse.name,
                  response: p.functionResponse.response
                };
                if (p.functionResponse.id) {
                  cleanResp.id = p.functionResponse.id;
                }
                return {
                  ...p,
                  functionResponse: cleanResp
                };
              } else {
                return p;
              }
            });
          } else {
            // Fallback for older messages
            if (msg.functionCall) {
              const cleanCall: any = {
                name: msg.functionCall.name,
                args: msg.functionCall.args
              };
              if (msg.functionCall.id) {
                cleanCall.id = msg.functionCall.id;
              }
              parts.push({ functionCall: cleanCall });
            } else if (msg.functionResponse) {
              const cleanResp: any = {
                name: msg.functionResponse.name,
                response: msg.functionResponse.response
              };
              if (msg.functionResponse.id) {
                cleanResp.id = msg.functionResponse.id;
              }
              parts.push({ functionResponse: cleanResp });
            } else {
              parts.push({ text: msg.content });
            }
          }

          // Attach active image to the user's text prompts
          if (msg.role === 'user' && imagePart) {
            const hasText = parts.some((p: any) => p.text);
            const hasResponse = parts.some((p: any) => p.functionResponse);
            const hasImage = parts.some((p: any) => p.inlineData);
            if (hasText && !hasResponse && !hasImage) {
              parts.push(imagePart);
            }
          }

          return {
            role: msg.role,
            parts: parts
          };
        });

        // Compute system instruction dynamically with canvas details
        const dims = this.canvasService.getCanvasDimensions();
        const dimsText = dims 
          ? `The currently loaded image is "${this.imageMetadata()?.name || 'unknown'}" with dimensions: width ${dims.width}px, height ${dims.height}px.`
          : `There is currently no image loaded or the canvas is empty.`;

        const systemInstruction = `You are a smart canvas AI assistant. You can view the floorplan/image provided by the user and manage annotations (layers) on it.
${dimsText}

You have tools to get, add, delete, and clear layers:
- getLayers: Retrieves current layers with their types and coordinates.
- addPolygons: Adds one or more polygons.
- deleteLayers: Deletes layers by indices.
- clearLayers: Deletes all layers.

IMPORTANT FOR COORDINATES:
- You can specify coordinates in 'pixels' (using the image dimensions above) or in 'normalized' format (a scale of 0 to 1000 for both X and Y axes, where 0 is the top/left edge and 1000 is the bottom/right edge of the image).
- Using 'normalized' coordinates is highly recommended because it matches the model's visual grounding/object detection coordinate space, making it easy to map rooms, furniture, or features.
- When the user asks you to mark rooms or icons, identify them in the image and create a polygon for each item with its name and exact coordinates. Do this in a single tool call ('addPolygons') for efficiency.
- COORDINATE GRID OVERLAY: The image you receive has a coordinate grid overlay (representing the 0 to 1000 normalized space, with grid lines and numbers every 100 units). Use these grid lines and labels to determine exact coordinates of elements.
- WARNING ON COORDINATE SWAPPING: In this toolset, the first coordinate is X (horizontal position, 0 = left, 1000 = right) and the second coordinate is Y (vertical position, 0 = top, 1000 = bottom). Some vision models default to [Y, X] order. You MUST use [X, Y] order. Do not swap X and Y coordinates.
- Respond in Spanish if the user's message is in Spanish.`;

        console.log('Gemini Request Contents:', JSON.stringify(contents.map(c => ({
          role: c.role,
          parts: c.parts.map((p: any) => p.text ? { text: p.text } : p.inlineData ? { inlineData: 'MIME:' + p.inlineData.mimeType + ' (len: ' + p.inlineData.data.length + ')' } : p)
        }))));

        const response = await this.aiClient.models.generateContent({
          model: thread.model || 'models/gemini-2.5-flash',
          contents: contents,
          config: {
            systemInstruction,
            tools: [{ 
              functionDeclarations: [
                helloWorldDeclaration,
                getLayersDeclaration,
                addPolygonsDeclaration,
                deleteLayersDeclaration,
                clearLayersDeclaration
              ] 
            }]
          }
        });

        console.log('Gemini API Response:', response);

        // Check for function calls
        if (response.functionCalls && response.functionCalls.length > 0) {
          const call = response.functionCalls[0];
          const callName = call.name;
          if (!callName) {
            break;
          }

          // 1. Save and display the function call message (role: model, status: 'running')
          const callMsgId = 'msg_' + Date.now() + '_call';
          const callMsg: ChatMessage = {
            id: callMsgId,
            threadId: thread.id,
            role: 'model',
            content: `[Tool Call] ${callName}`,
            timestamp: Date.now(),
            functionCall: {
              id: call.id,
              name: callName,
              args: call.args,
              status: 'running'
            },
            parts: response.candidates?.[0]?.content?.parts
          };
          await this.dbService.saveMessage(callMsg);
          this.messages.update(prev => [...prev, callMsg]);
          this.scrollToBottom();

          // 2. Execute the function locally (wrapped in try/catch to capture errors)
          let resultObj: any = {};
          let success = true;
          let errorText = '';
          try {
            if (callName === 'helloWorld') {
              const nameArg = (call.args as any)?.name || 'World';
              resultObj = { greeting: `Hello, ${nameArg}! This is a response from the Hello World tool.` };
            } else if (callName === 'getLayers') {
              const layers = this.canvasService.getLayers();
              resultObj = { layers };

            } else if (callName === 'addPolygons') {
              const polysArg = (call.args as any)?.polygons || [];
              const coordSys = (call.args as any)?.coordinateSystem;
              const res = this.canvasService.addPolygons(polysArg, coordSys);
              resultObj = res;
            } else if (callName === 'deleteLayers') {
              const indicesArg = (call.args as any)?.indices || [];
              const res = this.canvasService.deleteLayers(indicesArg);
              resultObj = res;
            } else if (callName === 'clearLayers') {
              const res = this.canvasService.clearLayers();
              resultObj = res;
            } else {
              throw new Error(`Tool ${callName} is not implemented.`);
            }
          } catch (err: any) {
            success = false;
            errorText = err.message || err.toString();
            resultObj = { error: errorText };
          }

          // Update the function call message status (success/error)
          callMsg.functionCall!.status = success ? 'success' : 'error';
          if (!success) {
            callMsg.functionCall!.error = errorText;
          }
          await this.dbService.saveMessage(callMsg);
          this.messages.update(list => list.map(m => m.id === callMsgId ? { ...callMsg } : m));

          // 3. Save the function response message in DB & local signal (needed for Gemini context, hidden in HTML UI)
          const respMsgId = 'msg_' + Date.now() + '_resp';
          const respMsg: ChatMessage = {
            id: respMsgId,
            threadId: thread.id,
            role: 'user',
            content: `[Tool Response] ${callName}`,
            timestamp: Date.now(),
            functionResponse: {
              id: call.id,
              name: callName,
              response: resultObj
            },
            parts: [{
              functionResponse: {
                id: call.id,
                name: callName,
                response: resultObj
              }
            }]
          };
          await this.dbService.saveMessage(respMsg);
          this.messages.update(prev => [...prev, respMsg]);
          this.scrollToBottom();

          // Continue loop to send tool output back to the model
          continue;
        }

        // No function calls, get final text response
        runModelLoop = false;
        
        const candidate = response.candidates?.[0];
        const finishReason = candidate?.finishReason;
        let responseText = response.text;

        if (finishReason && finishReason !== 'STOP') {
          responseText = `[Gemini Error] Generation stopped. Reason: ${finishReason}\n\nFull API response:\n${JSON.stringify(response, null, 2)}`;
        } else if (!responseText) {
          responseText = 'No response text or tools generated by the model.';
        }

        const modelMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const modelMsg: ChatMessage = {
          id: modelMsgId,
          threadId: thread.id,
          role: 'model',
          content: responseText,
          timestamp: Date.now(),
          parts: response.candidates?.[0]?.content?.parts
        };

        await this.dbService.saveMessage(modelMsg);
        this.messages.update(prev => [...prev, modelMsg]);
        this.scrollToBottom();
      }
    } catch (err: any) {
      console.error('Gemini API request failed', err);
      
      const errorMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      const errorText = `Error calling Gemini API: ${err.message || err.toString()}. Please verify your API Key and internet connection.`;
      
      const modelErrorMsg: ChatMessage = {
        id: errorMsgId,
        threadId: thread.id,
        role: 'model',
        content: errorText,
        timestamp: Date.now(),
      };
      
      try {
        await this.dbService.saveMessage(modelErrorMsg);
      } catch (dbErr) {
        console.error('Failed to save error message to IndexedDB', dbErr);
      }
      
      this.messages.update(prev => [...prev, modelErrorMsg]);
      this.scrollToBottom();
    } finally {
      this.isGenerating.set(false);
    }
  }

  protected goBackToThreads(): void {
    this.activeThread.set(null);
    this.messages.set([]);
    this.userMessageText = '';
    this.loadThreads();
  }

  protected async fetchModels(): Promise<void> {
    if (!this.aiClient) return;
    this.isLoadingModels.set(true);
    let list: ModelInfo[] = [];
    try {
      const pager = await this.aiClient.models.list();
      if (pager && pager.page) {
        const mappedList = pager.page
          .filter(m => m.supportedActions?.includes('generateContent'))
          .filter(m => {
            const name = (m.name || '').toLowerCase();
            // Dynamically select all Gemini models, excluding legacy text-only ones (gemini-1.0-pro)
            return name.includes('gemini') && !name.includes('gemini-1.0-pro');
          })
          .map(m => ({
            id: m.name || '',
            name: m.displayName || m.name?.replace('models/', '') || 'Gemini Model'
          }))
          .filter(m => m.id !== '');

        // Detect duplicate display names
        const nameCounts = new Map<string, number>();
        for (const item of mappedList) {
          nameCounts.set(item.name, (nameCounts.get(item.name) || 0) + 1);
        }

        // If duplicate display names exist, append clean ID in parentheses
        list = mappedList.map(item => {
          const hasDuplicate = (nameCounts.get(item.name) || 0) > 1;
          if (hasDuplicate) {
            const cleanId = item.id.replace('models/', '');
            return {
              id: item.id,
              name: `${item.name} (${cleanId})`
            };
          }
          return item;
        });
      }
    } catch (err) {
      console.warn('Failed to fetch models from API, falling back to defaults', err);
    }

    if (list.length === 0) {
      list = [
        { id: 'models/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'models/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        { id: 'models/gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
        { id: 'models/gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
      ];
    }
    this.availableModels.set(list);
    this.isLoadingModels.set(false);
  }

  protected async onModelChange(newModel: string): Promise<void> {
    const thread = this.activeThread();
    if (!thread) return;
    
    // Update active thread local state & IndexedDB
    thread.model = newModel;
    await this.dbService.saveThread(thread);
    await this.loadThreads();
  }

  protected openToolDetails(msg: ChatMessage, index: number): void {
    const list = this.messages();
    let call = msg.functionCall;
    let responseObj: any = null;

    if (call) {
      // Look for response in the next message
      const nextMsg = list[index + 1];
      if (nextMsg && nextMsg.functionResponse && nextMsg.functionResponse.name === call.name) {
        responseObj = nextMsg.functionResponse.response;
      }
    }

    if (call) {
      this.selectedToolDetails.set({
        name: call.name,
        args: call.args,
        response: responseObj || (call.status === 'running' ? { info: 'Tool is executing...' } : null),
        error: call.error
      });
    }
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.scrollContainer) {
        const element = this.scrollContainer.nativeElement;
        element.scrollTop = element.scrollHeight;
      }
    }, 50);
  }
}
