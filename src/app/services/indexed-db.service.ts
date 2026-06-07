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

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  timestamp: number;
  name?: string;
  toolCallId?: string;
  toolCalls?: any[];
}

export interface ChatHistoryRecord {
  imageId: number;
  messages: ChatMessage[];
}

@Injectable({
  providedIn: 'root',
})
export class IndexedDbService {
  private readonly dbName = 'SmartCanvasDB';
  private readonly storeName = 'images';
  private readonly chatStoreName = 'chat_history';
  private db: IDBDatabase | null = null;

  private initDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 2);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(this.chatStoreName)) {
          db.createObjectStore(this.chatStoreName, { keyPath: 'imageId' });
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
    // Delete chat history associated with the image first
    await this.deleteChatHistory(id).catch((err) =>
      console.warn(`Failed to delete chat history for image ${id}:`, err)
    );

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

  async getChatHistory(imageId: number): Promise<ChatMessage[]> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatStoreName, 'readonly');
      const store = transaction.objectStore(this.chatStoreName);
      const request = store.get(imageId);

      request.onsuccess = () => {
        const record = request.result as ChatHistoryRecord | undefined;
        resolve(record ? record.messages : []);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async saveChatHistory(imageId: number, messages: ChatMessage[]): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatStoreName, 'readwrite');
      const store = transaction.objectStore(this.chatStoreName);
      const record: ChatHistoryRecord = {
        imageId,
        messages,
      };
      const request = store.put(record);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async deleteChatHistory(imageId: number): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatStoreName, 'readwrite');
      const store = transaction.objectStore(this.chatStoreName);
      const request = store.delete(imageId);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }
}
