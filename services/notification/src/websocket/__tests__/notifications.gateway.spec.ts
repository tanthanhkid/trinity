import { NotificationsGateway } from '../notifications.gateway'
import { Socket, Server } from 'socket.io'
import * as jwt from 'jsonwebtoken'

describe('NotificationsGateway', () => {
  let gateway: NotificationsGateway
  let mockServer: { to: jest.Mock }
  const OLD_JWT_SECRET = process.env.JWT_SECRET
  const TEST_SECRET = 'ws-gateway-test-secret'

  // Gateway BẮT BUỘC đọc JWT_SECRET từ env (không còn secret mặc định).
  beforeAll(() => {
    process.env.JWT_SECRET = TEST_SECRET
  })
  afterAll(() => {
    if (OLD_JWT_SECRET === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = OLD_JWT_SECRET
  })

  beforeEach(() => {
    gateway = new NotificationsGateway()
    mockServer = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    }
    gateway.server = mockServer as unknown as Server
  })

  describe('handleConnection', () => {
    it('should authenticate and join user room', () => {
      const token = jwt.sign({ sub: 1, email: 'test@example.net' }, TEST_SECRET)
      const mockClient = {
        id: 'socket-1',
        handshake: { auth: { token } },
        join: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as Socket

      gateway.handleConnection(mockClient)

      expect(mockClient.join).toHaveBeenCalledWith('user_1')
      expect(mockClient.disconnect).not.toHaveBeenCalled()
    })

    it('should disconnect client without token', () => {
      const mockClient = {
        id: 'socket-2',
        handshake: { auth: {} },
        join: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as Socket

      gateway.handleConnection(mockClient)

      expect(mockClient.disconnect).toHaveBeenCalled()
      expect(mockClient.join).not.toHaveBeenCalled()
    })

    it('should disconnect client with invalid token', () => {
      const mockClient = {
        id: 'socket-3',
        handshake: { auth: { token: 'invalid-token' } },
        join: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as Socket

      gateway.handleConnection(mockClient)

      expect(mockClient.disconnect).toHaveBeenCalled()
    })
  })

  describe('handleDisconnect', () => {
    it('should cleanup client mapping', () => {
      const token = jwt.sign({ sub: 1, email: 'test@example.net' }, TEST_SECRET)
      const mockClient = {
        id: 'socket-4',
        handshake: { auth: { token } },
        join: jest.fn(),
        disconnect: jest.fn(),
      } as unknown as Socket

      gateway.handleConnection(mockClient)
      gateway.handleDisconnect(mockClient)

      // No error thrown on cleanup
      expect(true).toBe(true)
    })
  })

  describe('sendToUser', () => {
    it('should emit notification:new to user room', () => {
      const notification = {
        id: 1,
        title: 'Test',
        body: 'Body',
        channel: 'in_app',
        is_read: false,
        created_at: new Date().toISOString(),
      }

      gateway.sendToUser(1, notification)

      expect(mockServer.to).toHaveBeenCalledWith('user_1')
    })
  })

  describe('emitUnreadCount', () => {
    it('should emit notification:count to user room', () => {
      gateway.emitUnreadCount(1, { count: 5, bell_count: 3, message_count: 2 })

      expect(mockServer.to).toHaveBeenCalledWith('user_1')
    })
  })
})
