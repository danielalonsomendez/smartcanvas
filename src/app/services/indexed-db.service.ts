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
      const request = indexedDB.open(this.dbName, 2);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
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

}
