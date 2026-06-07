import { Routes } from '@angular/router';
import { CanvasComponent } from './pages/canvas/canvas.component';

export const routes: Routes = [
  { path: '', component: CanvasComponent },
  { path: 'photo/:id', component: CanvasComponent },
  { path: '**', redirectTo: '' },
];
