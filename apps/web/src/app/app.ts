import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RealtimeService } from './core/realtime.service';

@Component({
  selector: 'temp-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly realtime = inject(RealtimeService);

  readonly connected = this.realtime.connected;
  readonly status = this.realtime.status;

  /**
   * The stale-sensor banner.
   *
   * Layer 1 of the safety design holds last state when readings stop rather than
   * failing everything off or forcing heat on, and it says out loud that this is
   * "only sound if the alarm is actually visible". This is that alarm. It is a
   * required part of the feature, not a nice-to-have, which is why it lives in
   * the shell and not on a screen somebody might not be looking at.
   */
  readonly sensorStale = computed(() => this.status()?.sensorStale === true);

  readonly staleRoles = computed(() => this.status()?.staleRoles.join(', ') ?? '');

  ngOnInit(): void {
    this.realtime.connect();
  }
}
