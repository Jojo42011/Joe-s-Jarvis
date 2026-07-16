import { google } from 'googleapis';
import { getAuthorizedClient } from './auth';

export interface UpcomingEvent {
  event_id: string;
  summary: string;
  description: string;
  location: string;
  start_time: string;
  end_time: string;
  attendees: string;
  status: string;
}

/** Upcoming events for a mailbox's primary calendar. */
export async function listUpcoming(email: string, days: number): Promise<UpcomingEvent[]> {
  const auth = getAuthorizedClient(email);
  if (!auth) return [];
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const max = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  return (res.data.items || []).map((e) => ({
    event_id: e.id || '',
    summary: e.summary || '(no title)',
    description: e.description || '',
    location: e.location || '',
    start_time: e.start?.dateTime || e.start?.date || '',
    end_time: e.end?.dateTime || e.end?.date || '',
    attendees: (e.attendees || []).map((a) => a.email).filter(Boolean).join(', '),
    status: e.status || '',
  }));
}

/** Create an event on a mailbox's calendar. Reversible, so Arlo may do this directly. */
export async function createEvent(email: string, ev: {
  summary: string;
  description?: string;
  location?: string;
  start: string; // ISO datetime
  end: string;   // ISO datetime
  attendees?: string[];
  timeZone?: string;
}): Promise<{ id: string; htmlLink: string }> {
  const auth = getAuthorizedClient(email);
  if (!auth) throw new Error(`Account ${email} is not connected`);
  const calendar = google.calendar({ version: 'v3', auth });

  const tz = ev.timeZone || 'America/Phoenix';
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: ev.summary,
      description: ev.description,
      location: ev.location,
      start: { dateTime: ev.start, timeZone: tz },
      end: { dateTime: ev.end, timeZone: tz },
      attendees: (ev.attendees || []).map((e) => ({ email: e })),
    },
  });
  return { id: res.data.id || '', htmlLink: res.data.htmlLink || '' };
}
