import { Injectable } from '@angular/core';

export interface SavedImage {
  id?: number;
  name: string;
  dataUrl: string;
  size: string;
  width: number;
  height: number;
  timestamp: number;
  canvasData?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  functionCall?: {
    id?: string;
    name: string;
    args: any;
    status?: 'running' | 'success' | 'error';
    error?: string;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: any;
  };
  parts?: any[];
}

export interface ChatSetting {
  key: string;
  value: any;
}

@Injectable({
  providedIn: 'root',
})
export class IndexedDbService {
  private readonly dbName = 'SmartCanvasDB';
  private readonly storeName = 'images';
  private db: IDBDatabase | null = null;

  private initDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 3);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('chat_threads')) {
          db.createObjectStore('chat_threads', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('chat_messages')) {
          db.createObjectStore('chat_messages', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('chat_settings')) {
          db.createObjectStore('chat_settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async saveImage(image: Omit<SavedImage, 'id' | 'timestamp'>): Promise<SavedImage> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(transaction.objectStoreNames[0]);
      
      const record: SavedImage = {
        ...image,
        timestamp: Date.now(),
      };

      const request = store.add(record);

      request.onsuccess = () => {
        record.id = request.result as number;
        resolve(record);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async getImages(): Promise<SavedImage[]> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(transaction.objectStoreNames[0]);
      const request = store.getAll();

      request.onsuccess = () => {
        const results = request.result as SavedImage[];
        // Sort by timestamp descending (most recent first)
        results.sort((a, b) => b.timestamp - a.timestamp);
        resolve(results);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async deleteImage(id: number): Promise<void> {

    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async updateImageCanvasData(id: number, canvasData: string): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(transaction.objectStoreNames[0]);
      
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const image = getRequest.result as SavedImage;
        if (!image) {
          reject(new Error(`Image with id ${id} not found`));
          return;
        }

        image.canvasData = canvasData;

        const updateRequest = store.put(image);

        updateRequest.onsuccess = () => {
          resolve();
        };

        updateRequest.onerror = () => {
          reject(updateRequest.error);
        };
      };

      getRequest.onerror = () => {
        reject(getRequest.error);
      };
    });
  }

  // --- API Key / Settings ---
  async getApiKey(): Promise<string | null> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_settings', 'readonly');
      const store = transaction.objectStore('chat_settings');
      const request = store.get('gemini_api_key');
      request.onsuccess = () => {
        const res = request.result as ChatSetting | undefined;
        resolve(res ? res.value : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveApiKey(apiKey: string): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_settings', 'readwrite');
      const store = transaction.objectStore('chat_settings');
      const request = store.put({ key: 'gemini_api_key', value: apiKey });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteApiKey(): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_settings', 'readwrite');
      const store = transaction.objectStore('chat_settings');
      const request = store.delete('gemini_api_key');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // --- Chat Threads ---
  async getThreads(): Promise<ChatThread[]> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_threads', 'readonly');
      const store = transaction.objectStore('chat_threads');
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result as ChatThread[];
        results.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveThread(thread: ChatThread): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_threads', 'readwrite');
      const store = transaction.objectStore('chat_threads');
      const request = store.put(thread);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['chat_threads', 'chat_messages'], 'readwrite');
      const threadStore = transaction.objectStore('chat_threads');
      const messageStore = transaction.objectStore('chat_messages');
      
      const deleteThreadReq = threadStore.delete(threadId);
      
      deleteThreadReq.onsuccess = () => {
        const indexRequest = messageStore.openCursor();
        indexRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            const message = cursor.value as ChatMessage;
            if (message.threadId === threadId) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        indexRequest.onerror = () => reject(indexRequest.error);
      };
      
      deleteThreadReq.onerror = () => reject(deleteThreadReq.error);
    });
  }

  // --- Chat Messages ---
  async getMessages(threadId: string): Promise<ChatMessage[]> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_messages', 'readonly');
      const store = transaction.objectStore('chat_messages');
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result as ChatMessage[];
        const filtered = results.filter(msg => msg.threadId === threadId);
        filtered.sort((a, b) => a.timestamp - b.timestamp);
        resolve(filtered);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chat_messages', 'readwrite');
      const store = transaction.objectStore('chat_messages');
      const request = store.put(message);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

}
