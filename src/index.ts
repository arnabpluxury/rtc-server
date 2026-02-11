import http from 'http'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'

import { rtcServerConfig } from './config.js'

type RtcJwtPayload = {
  callId: string
  userId: string
  displayName: string
  roles: string[]
  participantRole: 'AGENT' | 'SUPERVISOR' | 'CUSTOMER'
}

type ClientState = {
  authenticated: boolean
  payload: RtcJwtPayload | null
}

type Participant = {
  userId: string
  displayName: string
  roles: string[]
  participantRole: RtcJwtPayload['participantRole']
}

type RoomState = {
  callId: string
  participants: Map<string, Participant>
}

const rooms = new Map<string, RoomState>()

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-length', Buffer.byteLength(json))
  res.end(json)
}

function safeJsonParse(input: string): any | null {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function normalizeRoles(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : []
  const normalized = raw
    .map((r) => (typeof r === 'string' ? r.trim().toUpperCase() : ''))
    .filter(Boolean)
  return Array.from(new Set(normalized))
}

function getOrCreateRoom(callId: string): RoomState {
  const existing = rooms.get(callId)
  if (existing) return existing

  const created: RoomState = {
    callId,
    participants: new Map(),
  }
  rooms.set(callId, created)
  return created
}

function roomRoster(room: RoomState) {
  return Array.from(room.participants.values()).map((p) => ({
    userId: p.userId,
    displayName: p.displayName,
    roles: p.roles,
    participantRole: p.participantRole,
  }))
}

function broadcastRoomRoster(wss: WebSocketServer, callId: string) {
  const room = rooms.get(callId)
  if (!room) return

  const payload = JSON.stringify({ type: 'roster', callId, roster: roomRoster(room) })

  for (const client of wss.clients) {
    const state = (client as any)._state as ClientState | undefined
    if (!state?.authenticated || state.payload?.callId !== callId) continue
    if (client.readyState !== client.OPEN) continue
    client.send(payload)
  }
}

function verifyToken(token: string): RtcJwtPayload {
  const decoded = jwt.verify(token, rtcServerConfig.jwt.tokenSecret, {
    algorithms: ['HS256'],
    issuer: rtcServerConfig.jwt.issuer,
    audience: rtcServerConfig.jwt.audience,
  })

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid token')
  }

  const callId = typeof (decoded as any).callId === 'string' ? (decoded as any).callId.trim() : ''
  const userId = typeof (decoded as any).userId === 'string' ? (decoded as any).userId.trim() : ''
  const displayName = typeof (decoded as any).displayName === 'string' ? (decoded as any).displayName.trim() : ''
  const roles = normalizeRoles((decoded as any).roles)
  const participantRole = (decoded as any).participantRole as any

  if (!callId || !userId) throw new Error('Invalid token payload')

  if (participantRole !== 'AGENT' && participantRole !== 'SUPERVISOR' && participantRole !== 'CUSTOMER') {
    throw new Error('Invalid participantRole')
  }

  return { callId, userId, displayName: displayName || userId, roles, participantRole }
}

const server = http.createServer((req, res) => {
  if (!req.url) return jsonResponse(res, 404, { error: 'Not found' })

  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { ok: true })
  }

  return jsonResponse(res, 404, { error: 'Not found' })
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket) => {
  ;(socket as any)._state = { authenticated: false, payload: null } satisfies ClientState

  socket.send(JSON.stringify({
    type: 'hello',
    requires: ['auth'],
  }))

  socket.on('message', (data) => {
    const state = (socket as any)._state as ClientState

    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : ''
    const msg = safeJsonParse(text)

    if (!msg || typeof msg?.type !== 'string') {
      socket.send(JSON.stringify({ type: 'error', error: 'Invalid message' }))
      return
    }

    if (msg.type === 'auth') {
      if (state.authenticated) {
        socket.send(JSON.stringify({ type: 'error', error: 'Already authenticated' }))
        return
      }

      const token = typeof msg?.token === 'string' ? msg.token : ''
      if (!token) {
        socket.send(JSON.stringify({ type: 'error', error: 'Missing token' }))
        return
      }

      try {
        const payload = verifyToken(token)

        state.authenticated = true
        state.payload = payload

        const room = getOrCreateRoom(payload.callId)
        room.participants.set(payload.userId, {
          userId: payload.userId,
          displayName: payload.displayName,
          roles: payload.roles,
          participantRole: payload.participantRole,
        })

        socket.send(JSON.stringify({ type: 'auth_ok', callId: payload.callId, userId: payload.userId }))
        broadcastRoomRoster(wss, payload.callId)
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid token' }))
      }

      return
    }

    if (!state.authenticated || !state.payload) {
      socket.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }))
      return
    }

    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', t: Date.now() }))
      return
    }

    socket.send(JSON.stringify({ type: 'error', error: 'Unknown message type' }))
  })

  socket.on('close', () => {
    const state = (socket as any)._state as ClientState
    const payload = state.payload
    if (!state.authenticated || !payload) return

    const room = rooms.get(payload.callId)
    if (room) {
      room.participants.delete(payload.userId)
      if (room.participants.size === 0) {
        rooms.delete(payload.callId)
      } else {
        broadcastRoomRoster(wss, payload.callId)
      }
    }
  })
})

server.listen(rtcServerConfig.httpPort, '0.0.0.0', () => {
  console.log(`RTC server listening on :${rtcServerConfig.httpPort}`)
})
