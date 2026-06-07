import { inject, Injectable, signal } from '@angular/core';
import { ChatMessage, IndexedDbService, SavedImage } from './indexed-db.service';
import { CanvasActions } from '../components/canvas-editor/canvas-editor.component';

export interface GitHubProfile {
  login: string;
  id: number;
  avatar_url: string;
  name: string;
  bio: string;
}

@Injectable({
  providedIn: 'root',
})
export class CopilotService {
  private readonly dbService = inject(IndexedDbService);

  readonly token = signal<string | null>(localStorage.getItem('github_token'));
  readonly userProfile = signal<GitHubProfile | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly isThinking = signal<boolean>(false);
  readonly selectedModel = signal<string>('openai/gpt-4o-mini');
  readonly models = signal<{ id: string; name: string; publisher: string }[]>([]);

  constructor() {
    const cachedProfile = localStorage.getItem('github_profile');
    if (cachedProfile) {
      try {
        this.userProfile.set(JSON.parse(cachedProfile));
      } catch {
        localStorage.removeItem('github_profile');
      }
    }
    if (this.token()) {
      this.loadStaticModels();
    }
  }

  /**
   * Log in with a GitHub Personal Access Token
   */
  async login(patToken: string): Promise<void> {
    if (!patToken || !patToken.trim()) {
      throw new Error('Token is required');
    }

    const cleanedToken = patToken.trim();
    
    // Validate token by fetching the user profile
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${cleanedToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      throw new Error('Invalid GitHub Token. Please make sure the token is active and valid.');
    }

    const profile: GitHubProfile = await response.json();
    
    // Store in localStorage
    localStorage.setItem('github_token', cleanedToken);
    localStorage.setItem('github_profile', JSON.stringify(profile));
    
    // Set signals
    this.token.set(cleanedToken);
    this.userProfile.set(profile);

    this.loadStaticModels();
  }

  /**
   * Log out and clear state
   */
  logout(): void {
    localStorage.removeItem('github_token');
    localStorage.removeItem('github_profile');
    this.token.set(null);
    this.userProfile.set(null);
    this.messages.set([]);
    this.models.set([]);
  }

  /**
   * Load chat history from IndexedDB for a given image
   */
  async loadHistory(imageId: number): Promise<void> {
    try {
      const history = await this.dbService.getChatHistory(imageId);
      this.messages.set(history);
    } catch (err) {
      console.error('Failed to load chat history from IndexedDB', err);
      this.messages.set([]);
    }
  }

  /**
   * Clear chat history for a given image
   */
  async clearChat(imageId: number): Promise<void> {
    try {
      await this.dbService.deleteChatHistory(imageId);
      this.messages.set([]);
    } catch (err) {
      console.error('Failed to clear chat history in IndexedDB', err);
    }
  }

  /**
   * Send a user message and run the agentic chat completion loop with the GitHub Models API.
   * Includes canvas context, tool calling capabilities, and updates IndexedDB.
   */
  async sendMessage(
    imageId: number,
    text: string,
    imageSrc: string | null,
    layers: any[],
    onChunk: (chunk: string) => void,
    canvasActions?: CanvasActions | null,
    imageMetadata?: { name: string; width: number; height: number; size: string } | null
  ): Promise<void> {
    const currentToken = this.token();
    if (!currentToken) {
      throw new Error('No GitHub token found. Please sign in.');
    }

    // 1. Add User Message
    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    
    const updatedMessages = [...this.messages(), userMsg];
    this.messages.set(updatedMessages);
    await this.dbService.saveChatHistory(imageId, updatedMessages);

    this.isThinking.set(true);

    try {
      // 2. Downscale the image if present to save bandwidth
      let compressedImageBase64: string | null = null;
      if (imageSrc && this.containsImageKeywords(text)) {
        compressedImageBase64 = await this.downscaleBase64(imageSrc).catch(() => null);
      }

      // 3. Assemble message list for API
      const apiMessages = await this.buildApiMessages(updatedMessages, compressedImageBase64, layers, imageMetadata);

      // 4. Send request and handle potential tool calls
      await this.executeChatCompletionLoop(imageId, apiMessages, currentToken, onChunk, canvasActions);
    } catch (err: any) {
      console.error('Error in Copilot chat communication:', err);
      const errMsg: ChatMessage = {
        role: 'assistant',
        content: `Error: ${err.message || 'Failed to communicate with GitHub Copilot.'}`,
        timestamp: Date.now(),
      };
      const finalMsgs = [...this.messages(), errMsg];
      this.messages.set(finalMsgs);
      await this.dbService.saveChatHistory(imageId, finalMsgs);
    } finally {
      this.isThinking.set(false);
    }
  }

  /**
   * Core completion loop that handles function tool calling and final response streaming.
   */
  private async executeChatCompletionLoop(
    imageId: number,
    apiMessages: any[],
    token: string,
    onChunk: (chunk: string) => void,
    canvasActions?: CanvasActions | null
  ): Promise<void> {
    // Full canvas tool definitions
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_canvas_layers',
          description: 'Returns the complete list of all shapes/layers currently drawn on the canvas with their properties (position, size, color, visibility). Call this first before making any modifications to understand the current state.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'add_rectangle',
          description: 'Adds a new rectangle shape to the canvas. Coordinates are in image pixels (origin at top-left). Use get_canvas_layers first to understand the existing layout and avoid overlaps.',
          parameters: {
            type: 'object',
            properties: {
              x:           { type: 'number', description: 'Left position in image pixels (from left edge)' },
              y:           { type: 'number', description: 'Top position in image pixels (from top edge)' },
              width:       { type: 'number', description: 'Width of the rectangle in image pixels' },
              height:      { type: 'number', description: 'Height of the rectangle in image pixels' },
              stroke:      { type: 'string', description: 'Border color as hex string (e.g. "#e11d48"). Defaults to indigo.' },
              fill:        { type: 'string', description: 'Fill color as hex string (e.g. "#fb7185"). Defaults to light indigo.' },
              fillOpacity: { type: 'number', description: 'Fill opacity from 0.0 (transparent) to 1.0 (opaque). Default is 0.2.' },
              strokeWidth: { type: 'number', description: 'Border thickness in pixels. Default is 3.' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'add_polygon',
          description: 'Adds a new polygon/freeform shape to the canvas by specifying its vertices. Requires at least 3 points. Coordinates are in image pixels.',
          parameters: {
            type: 'object',
            properties: {
              points: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' } },
                  required: ['x', 'y'],
                },
                description: 'Array of vertex coordinates [{x, y}, ...] in image pixels. Minimum 3 points.',
              },
              stroke:      { type: 'string', description: 'Border color as hex (e.g. "#059669").' },
              fill:        { type: 'string', description: 'Fill color as hex.' },
              fillOpacity: { type: 'number', description: 'Fill opacity 0.0–1.0. Default 0.2.' },
              strokeWidth: { type: 'number', description: 'Border thickness in pixels. Default 3.' },
            },
            required: ['points'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'update_layer',
          description: 'Modifies properties of an existing shape/layer by its zero-based index. Use get_canvas_layers first to obtain valid indices and current properties.',
          parameters: {
            type: 'object',
            properties: {
              layerIndex:  { type: 'number', description: 'Zero-based index of the layer from get_canvas_layers.' },
              x:           { type: 'number', description: 'New left position in image pixels.' },
              y:           { type: 'number', description: 'New top position in image pixels.' },
              width:       { type: 'number', description: 'New width in pixels (rectangles only).' },
              height:      { type: 'number', description: 'New height in pixels (rectangles only).' },
              stroke:      { type: 'string', description: 'New border color as hex.' },
              fill:        { type: 'string', description: 'New fill color as hex.' },
              fillOpacity: { type: 'number', description: 'New fill opacity 0.0–1.0.' },
              strokeWidth: { type: 'number', description: 'New border thickness in pixels.' },
              visible:     { type: 'boolean', description: 'Whether the layer should be visible.' },
            },
            required: ['layerIndex'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'delete_layer',
          description: 'Permanently removes a shape/layer from the canvas by its zero-based index. Use get_canvas_layers first to confirm the correct index.',
          parameters: {
            type: 'object',
            properties: {
              layerIndex: { type: 'number', description: 'Zero-based index of the layer to delete.' },
            },
            required: ['layerIndex'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'set_layer_visibility',
          description: 'Shows or hides a specific layer without deleting it.',
          parameters: {
            type: 'object',
            properties: {
              layerIndex: { type: 'number', description: 'Zero-based index of the layer.' },
              visible:    { type: 'boolean', description: 'true to show the layer, false to hide it.' },
            },
            required: ['layerIndex', 'visible'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'clear_all_layers',
          description: 'Removes ALL shapes from the canvas, keeping only the background image. Only call this when the user has explicitly asked to clear or reset everything.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_saved_images',
          description: 'Returns a list of all images saved in the SmartCanvas database, including their names, dimensions, and timestamps.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];

    // First request - non-streaming to make parsing tool calls simple and robust
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.selectedModel(),
        messages: apiMessages,
        tools: tools,
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`GitHub Models API returned status ${response.status}: ${errorText || response.statusText}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new Error('Received an empty response from GitHub Models.');
    }

    // Check if the model requested any tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      // 1. Add assistant message with tool calls to local UI and IndexedDB
      const assistantToolCallMsg: ChatMessage = {
        role: 'assistant',
        content: null,
        timestamp: Date.now(),
        toolCalls: message.tool_calls,
      };

      let currentMessages = [...this.messages(), assistantToolCallMsg];
      this.messages.set(currentMessages);
      await this.dbService.saveChatHistory(imageId, currentMessages);

      // Append assistant message (with tool calls) to apiMessages for the next turn
      apiMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: message.tool_calls,
      });

      // 2. Execute each tool call
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name as string;
        let args: any = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          args = {};
        }

        let toolResult = '';

        // ── get_canvas_layers ──────────────────────────────────────────────
        if (toolName === 'get_canvas_layers') {
          if (canvasActions) {
            const layers = canvasActions.getLayers();
            if (layers.length === 0) {
              toolResult = 'The canvas has no shapes drawn yet.';
            } else {
              toolResult = `Canvas has ${layers.length} layer(s):\n` +
                layers.map((l) => {
                  let desc = `[${l.index}] ${l.name} | type: ${l.type} | pos: (${l.x}, ${l.y}) | stroke: ${l.stroke} | visible: ${l.visible}`;
                  if (l.width !== undefined) desc += ` | size: ${l.width}×${l.height}px`;
                  if (l.points) desc += ` | points: ${l.points.length}`;
                  return desc;
                }).join('\n');
            }
          } else {
            toolResult = 'Canvas actions not available in this context.';
          }

        // ── add_rectangle ──────────────────────────────────────────────────
        } else if (toolName === 'add_rectangle') {
          if (canvasActions) {
            if (args.x === undefined || args.y === undefined || args.width === undefined || args.height === undefined) {
              toolResult = 'Error: x, y, width and height are required to add a rectangle.';
            } else {
              canvasActions.addRectangle({
                x: args.x, y: args.y, width: args.width, height: args.height,
                stroke: args.stroke, fill: args.fill,
                fillOpacity: args.fillOpacity, strokeWidth: args.strokeWidth,
              });
              toolResult = `Rectangle added at (${args.x}, ${args.y}) with size ${args.width}×${args.height}px.`;
              if (args.stroke) toolResult += ` Color: ${args.stroke}.`;
            }
          } else {
            toolResult = 'Canvas actions not available.';
          }

        // ── add_polygon ────────────────────────────────────────────────────
        } else if (toolName === 'add_polygon') {
          if (canvasActions) {
            const pts = args.points as { x: number; y: number }[];
            if (!pts || pts.length < 3) {
              toolResult = 'Error: at least 3 points are required to add a polygon.';
            } else {
              canvasActions.addPolygon({
                points: pts, stroke: args.stroke, fill: args.fill,
                fillOpacity: args.fillOpacity, strokeWidth: args.strokeWidth,
              });
              toolResult = `Polygon added with ${pts.length} vertices.`;
            }
          } else {
            toolResult = 'Canvas actions not available.';
          }

        // ── update_layer ───────────────────────────────────────────────────
        } else if (toolName === 'update_layer') {
          if (canvasActions) {
            const idx = args.layerIndex as number;
            const ok = canvasActions.updateLayer(idx, {
              x: args.x, y: args.y, width: args.width, height: args.height,
              stroke: args.stroke, fill: args.fill,
              fillOpacity: args.fillOpacity, strokeWidth: args.strokeWidth,
              visible: args.visible,
            });
            toolResult = ok
              ? `Layer ${idx} updated successfully.`
              : `Error: layer index ${idx} is out of range. Use get_canvas_layers to check valid indices.`;
          } else {
            toolResult = 'Canvas actions not available.';
          }

        // ── delete_layer ───────────────────────────────────────────────────
        } else if (toolName === 'delete_layer') {
          if (canvasActions) {
            const idx = args.layerIndex as number;
            const ok = canvasActions.deleteLayer(idx);
            toolResult = ok
              ? `Layer ${idx} deleted successfully.`
              : `Error: layer index ${idx} is out of range.`;
          } else {
            toolResult = 'Canvas actions not available.';
          }

        // ── set_layer_visibility ───────────────────────────────────────────
        } else if (toolName === 'set_layer_visibility') {
          if (canvasActions) {
            const idx = args.layerIndex as number;
            const vis = args.visible as boolean;
            const ok = canvasActions.setLayerVisibility(idx, vis);
            toolResult = ok
              ? `Layer ${idx} is now ${vis ? 'visible' : 'hidden'}.`
              : `Error: layer index ${idx} is out of range.`;
          } else {
            toolResult = 'Canvas actions not available.';
          }

        // ── clear_all_layers ───────────────────────────────────────────────
        } else if (toolName === 'clear_all_layers') {
          if (canvasActions) {
            canvasActions.clearAllLayers();
            toolResult = 'All layers have been cleared from the canvas.';
          } else {
            toolResult = 'Canvas actions not available.';
          }

        // ── list_saved_images ──────────────────────────────────────────────
        } else if (toolName === 'list_saved_images') {
          try {
            const images = await this.dbService.getImages();
            if (images.length === 0) {
              toolResult = 'No images saved in SmartCanvas yet.';
            } else {
              toolResult = `Found ${images.length} saved image(s):\n` +
                images.map((img, i) =>
                  `[${i}] "${img.name}" — ${img.width}×${img.height}px, ${img.size}, ID: ${img.id}`
                ).join('\n');
            }
          } catch {
            toolResult = 'Error reading the image database.';
          }

        // ── unknown tool ───────────────────────────────────────────────────
        } else {
          toolResult = `Unknown tool: ${toolName}.`;
        }

        // 3. Add Tool response to conversation
        const toolMsg: ChatMessage = {
          role: 'tool',
          content: toolResult,
          timestamp: Date.now(),
          name: toolName,
          toolCallId: toolCall.id,
        };

        currentMessages = [...this.messages(), toolMsg];
        this.messages.set(currentMessages);
        await this.dbService.saveChatHistory(imageId, currentMessages);

        // Append to apiMessages for the next API call
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: toolResult,
        });
      }

      // 4. Trigger second call (this will respond to the tool execution)
      // For the second response, we stream it to the user
      await this.streamFinalResponse(imageId, apiMessages, token, onChunk);
    } else {
      // No tool calls, just normal text content
      const content = message.content || '';
      
      // Simulate streaming in UI for standard text (gives uniform premium feel)
      await this.simulateStreaming(imageId, content, onChunk);
    }
  }

  /**
   * Streams the final response to the user via Server-Sent Events (SSE)
   */
  private async streamFinalResponse(
    imageId: number,
    apiMessages: any[],
    token: string,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.selectedModel(),
        messages: apiMessages,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to stream final response. Status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable.');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedContent = '';

    // Create placeholder assistant message
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    
    this.messages.update((msgs) => [...msgs, assistantMsg]);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const cleaned = line.trim();
        if (!cleaned.startsWith('data: ')) continue;
        const dataStr = cleaned.slice(6);
        if (dataStr === '[DONE]') break;

        try {
          const parsed = JSON.parse(dataStr);
          const chunk = parsed.choices?.[0]?.delta?.content || '';
          if (chunk) {
            accumulatedContent += chunk;
            onChunk(chunk);
            
            // Update the last message in signal
            this.messages.update((msgs) => {
              const copy = [...msgs];
              if (copy.length > 0) {
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  content: accumulatedContent,
                };
              }
              return copy;
            });
          }
        } catch {
          // ignore parsing error on cut lines
        }
      }
    }

    // Final save of accumulated content to DB
    await this.dbService.saveChatHistory(imageId, this.messages());
  }

  /**
   * Helper to simulate a typing stream for a static response
   */
  private async simulateStreaming(imageId: number, content: string, onChunk: (chunk: string) => void): Promise<void> {
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    this.messages.update((msgs) => [...msgs, assistantMsg]);

    const words = content.split(/(\s+)/);
    let currentText = '';

    for (const word of words) {
      currentText += word;
      onChunk(word);
      
      this.messages.update((msgs) => {
        const copy = [...msgs];
        if (copy.length > 0) {
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            content: currentText,
          };
        }
        return copy;
      });

      // Delay to simulate typing
      await new Promise((r) => setTimeout(r, 15));
    }

    // Save history
    await this.dbService.saveChatHistory(imageId, this.messages());
  }

  /**
   * Build the messages array with system context and vision-friendly payload
   */
  private async buildApiMessages(
    history: ChatMessage[],
    imageBase64: string | null,
    layers: any[],
    imageMetadata?: { name: string; width: number; height: number; size: string } | null
  ): Promise<any[]> {
    // 1. Compile System Prompt with Canvas Context
    let layersContext = 'No layers are currently drawn on the canvas.';
    if (layers && layers.length > 0) {
      layersContext = `There are currently ${layers.length} shapes/layers drawn on the image: \n`;
      layers.forEach((layer, idx) => {
        layersContext += `${idx + 1}. Shape Name: "${layer.name}", Type: "${layer.type}", Color: "${layer.stroke}", Visibility: ${layer.visible ? 'Visible' : 'Hidden'}, Active: ${layer.isActive ? 'Yes' : 'No'}.\n`;
      });
    }

    let imageContext = '';
    if (imageMetadata) {
      imageContext = `\nActive image: "${imageMetadata.name}" (${imageMetadata.width}×${imageMetadata.height}px, ${imageMetadata.size}).`;
    }

    const systemPrompt = `You are a helpful AI assistant integrated into the SmartCanvas image editor.
You are helping the user analyze and annotate their photos.
Current user profile name: ${this.userProfile()?.name || this.userProfile()?.login}.${imageContext}

Here is the current workspace canvas context:
${layersContext}

Instructions:
- Be concise, helpful, and friendly.
- Format your responses clearly using Markdown.
- You have canvas editing tools available. Use them when the user asks to add, modify, or remove shapes.
- Always call get_canvas_layers first before any modification to confirm the current state.
- When adding shapes, use sensible defaults (indigo color, 0.2 opacity) unless the user specifies otherwise.
- Coordinates are in image pixels, with (0,0) at the top-left corner of the image.
- If the user asks about their shapes, refer to the details provided in the system context.
- If the user has sent an image, analyze both the image contents and how their shapes relate to the image.`;

    const result: any[] = [{ role: 'system', content: systemPrompt }];

    // 2. Add history (convert ChatMessage format to API format)
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === 'user') {
        // For the very last user message, if we have an image payload, attach it
        if (i === history.length - 1 && imageBase64) {
          result.push({
            role: 'user',
            content: [
              { type: 'text', text: msg.content || '' },
              {
                type: 'image_url',
                image_url: {
                  url: imageBase64,
                },
              },
            ],
          });
        } else {
          result.push({
            role: 'user',
            content: msg.content,
          });
        }
      } else if (msg.role === 'assistant') {
        result.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.toolCalls,
        });
      } else if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          name: msg.name,
          content: msg.content,
        });
      }
    }

    return result;
  }

  /**
   * Helper to check if the prompt mentions image/canvas keywords to trigger vision analysis
   */
  private containsImageKeywords(text: string): boolean {
    const query = text.toLowerCase();
    const keywords = [
      'imagen',
      'foto',
      'canvas',
      'lienzo',
      'image',
      'photo',
      'picture',
      'draw',
      've',
      'describe',
      'qué hay',
      'dibuja',
      'figura',
      'rectangulo',
      'poligono',
      'color',
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Helper to downscale base64 image representation
   */
  private downscaleBase64(dataUrl: string, maxW = 512, maxH = 512): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxW || h > maxH) {
          if (w > h) {
            h = Math.round((h * maxW) / w);
            w = maxW;
          } else {
            w = Math.round((w * maxH) / h);
            h = maxH;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => {
        resolve(dataUrl);
      };
      img.src = dataUrl;
    });
  }

  loadStaticModels(): void {
    // Static catalog from GitHub Models (bypasses CORS restriction on /catalog/models)
    // Filtered: only models with text output (excludes embeddings)
    const catalog = [
      { id: 'openai/gpt-4.1',                               name: 'GPT-4.1',                              publisher: 'OpenAI' },
      { id: 'openai/gpt-4.1-mini',                          name: 'GPT-4.1 mini',                         publisher: 'OpenAI' },
      { id: 'openai/gpt-4.1-nano',                          name: 'GPT-4.1 nano',                         publisher: 'OpenAI' },
      { id: 'openai/gpt-4o',                                name: 'GPT-4o',                               publisher: 'OpenAI' },
      { id: 'openai/gpt-4o-mini',                           name: 'GPT-4o mini',                          publisher: 'OpenAI' },
      { id: 'openai/gpt-5',                                 name: 'GPT-5',                                publisher: 'OpenAI' },
      { id: 'openai/gpt-5-chat',                            name: 'GPT-5 Chat (preview)',                 publisher: 'OpenAI' },
      { id: 'openai/gpt-5-mini',                            name: 'GPT-5 mini',                           publisher: 'OpenAI' },
      { id: 'openai/gpt-5-nano',                            name: 'GPT-5 nano',                           publisher: 'OpenAI' },
      { id: 'openai/o1',                                    name: 'o1',                                   publisher: 'OpenAI' },
      { id: 'openai/o1-mini',                               name: 'o1-mini',                              publisher: 'OpenAI' },
      { id: 'openai/o1-preview',                            name: 'o1-preview',                           publisher: 'OpenAI' },
      { id: 'openai/o3',                                    name: 'o3',                                   publisher: 'OpenAI' },
      { id: 'openai/o3-mini',                               name: 'o3-mini',                              publisher: 'OpenAI' },
      { id: 'openai/o4-mini',                               name: 'o4-mini',                              publisher: 'OpenAI' },
      { id: 'cohere/cohere-command-a',                      name: 'Command A',                            publisher: 'Cohere' },
      { id: 'deepseek/deepseek-r1',                         name: 'DeepSeek-R1',                          publisher: 'DeepSeek' },
      { id: 'deepseek/deepseek-r1-0528',                    name: 'DeepSeek-R1-0528',                     publisher: 'DeepSeek' },
      { id: 'deepseek/deepseek-v3-0324',                    name: 'DeepSeek-V3-0324',                     publisher: 'DeepSeek' },
      { id: 'meta/llama-3.2-11b-vision-instruct',           name: 'Llama 3.2 11B Vision',                 publisher: 'Meta' },
      { id: 'meta/llama-3.2-90b-vision-instruct',           name: 'Llama 3.2 90B Vision',                 publisher: 'Meta' },
      { id: 'meta/llama-3.3-70b-instruct',                  name: 'Llama 3.3 70B',                        publisher: 'Meta' },
      { id: 'meta/llama-4-maverick-17b-128e-instruct-fp8',  name: 'Llama 4 Maverick 17B',                 publisher: 'Meta' },
      { id: 'meta/llama-4-scout-17b-16e-instruct',          name: 'Llama 4 Scout 17B',                    publisher: 'Meta' },
      { id: 'meta/meta-llama-3.1-405b-instruct',            name: 'Llama 3.1 405B',                       publisher: 'Meta' },
      { id: 'meta/meta-llama-3.1-8b-instruct',              name: 'Llama 3.1 8B',                         publisher: 'Meta' },
      { id: 'mistral-ai/codestral-2501',                    name: 'Codestral 25.01',                      publisher: 'Mistral AI' },
      { id: 'mistral-ai/ministral-3b',                      name: 'Ministral 3B',                         publisher: 'Mistral AI' },
      { id: 'mistral-ai/mistral-medium-2505',               name: 'Mistral Medium 3',                     publisher: 'Mistral AI' },
      { id: 'mistral-ai/mistral-small-2503',                name: 'Mistral Small 3.1',                    publisher: 'Mistral AI' },
      { id: 'microsoft/phi-4',                              name: 'Phi-4',                                publisher: 'Microsoft' },
      { id: 'microsoft/phi-4-mini-instruct',                name: 'Phi-4 mini',                           publisher: 'Microsoft' },
      { id: 'microsoft/phi-4-mini-reasoning',               name: 'Phi-4 mini reasoning',                 publisher: 'Microsoft' },
      { id: 'microsoft/phi-4-multimodal-instruct',          name: 'Phi-4 multimodal',                     publisher: 'Microsoft' },
      { id: 'microsoft/phi-4-reasoning',                    name: 'Phi-4 reasoning',                      publisher: 'Microsoft' },
    ];

    this.models.set(catalog);

    // Keep current selection if valid, otherwise default to gpt-4o-mini
    if (!catalog.some(m => m.id === this.selectedModel())) {
      const fallback = catalog.find(m => m.id === 'openai/gpt-4o-mini');
      this.selectedModel.set(fallback ? fallback.id : catalog[0].id);
    }
  }
}
