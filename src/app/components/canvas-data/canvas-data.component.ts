import { Component } from '@angular/core';

@Component({
  selector: 'app-canvas-data',
  standalone: true,
  imports: [],
  template: `
    <div class="w-full h-full flex flex-col items-center justify-center text-center p-8 bg-zinc-900 select-none">
      <div class="w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center mb-4 text-zinc-400">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
        </svg>
      </div>
      <h3 class="font-medium text-xs text-white mb-1">Data View</h3>
      <p class="text-[11px] text-zinc-500 max-w-xs leading-relaxed">
        This section is reserved for shape data coordinates, export files, and metadata metrics. Coming soon.
      </p>
    </div>
  `,
})
export class CanvasDataComponent {}
