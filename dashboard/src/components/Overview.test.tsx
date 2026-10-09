import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Overview } from './Overview';
import type { DashboardApi } from '../api';
import type { Overview as OverviewData } from '../types';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('polls every 30 seconds only while visible and refreshes when the tab becomes visible', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const data: OverviewData = { identity: { accountId: 'account', agentId: 'admin', admin: true }, revision: '1', updatedAt: new Date().toISOString(),
    counts: Object.fromEntries(['categories', 'skills', 'subskills', 'resources'].map((key) => [key, { active: 0, disabled: 0, archived: 0, total: 0 }])) as OverviewData['counts'] };
  const overview = vi.fn(async () => data);
  render(<Overview api={{ overview } as unknown as DashboardApi} data={data} onUpdate={vi.fn()} onCatalog={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(overview).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(overview).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(overview).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(overview).toHaveBeenCalledTimes(3);
});
