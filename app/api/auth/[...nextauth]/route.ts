import { spaceAbi } from '@/lib/abi'
import { PROJECT_ID } from '@/lib/constants'
import { prisma } from '@/lib/prisma'
import { SubscriptionInSession } from '@/lib/types'
import { getChain } from '@/lib/wagmi'
import { User, UserRole } from '@prisma/client'
import { AuthTokenClaims, PrivyClient } from '@privy-io/server-auth'
import {
  getAddressFromMessage,
  getChainIdFromMessage,
  verifySignature,
  type SIWESession,
} from '@reown/appkit-siwe'
import NextAuth, { type NextAuthOptions } from 'next-auth'
import credentialsProvider from 'next-auth/providers/credentials'
import { Address, createPublicClient, http } from 'viem'

type GoogleLoginInfo = {
  email: string
  openid: string
  picture: string
  name: string
}

declare module 'next-auth' {
  interface Session extends SIWESession {
    address: string
    name: string
    chainId: number | string
    userId: string
    ensName: string | null
    role: string
    subscriptions: SubscriptionInSession[]
  }
}

export { handler as GET, handler as POST }

async function handler(req: Request, res: Response) {
  const nextAuthSecret = await getAuthSecret()
  if (!nextAuthSecret) {
    throw new Error('NEXTAUTH_SECRET is not set')
  }

  return await NextAuth(req as any, res as any, {
    secret: nextAuthSecret,
    providers: [
      credentialsProvider({
        name: 'Ethereum',
        credentials: {
          message: {
            label: 'Message',
            type: 'text',
            placeholder: '0x0',
          },
          signature: {
            label: 'Signature',
            type: 'text',
            placeholder: '0x0',
          },
        },
        async authorize(credentials) {
          try {
            if (!credentials?.message) {
              throw new Error('SiweMessage is undefined')
            }
            const { message, signature } = credentials
            const address = getAddressFromMessage(message)
            const chainId = getChainIdFromMessage(message)

            const isValid = await verifySignature({
              address,
              message,
              signature,
              chainId,
              projectId: PROJECT_ID,
            })

            if (isValid) {
              const user = await createUserByAddress(address)
              updateSubscriptions(address as Address)
              return { chainId, ...user }
            }

            return null
          } catch (e) {
            return null
          }
        },
      }),
      credentialsProvider({
        id: 'privy',
        name: 'Privy',
        credentials: {
          token: {
            label: 'Token',
            type: 'text',
            placeholder: '',
          },
          address: {
            label: 'Address',
            type: 'text',
            placeholder: '',
          },
        },
        async authorize(credentials) {
          try {
            if (!credentials?.token || !credentials?.address) {
              throw new Error('Token is undefined')
            }

            const { token, address } = credentials
            // console.log('====== token, address:', token, address)
            const site = await prisma.site.findFirst()
            if (!site) return null

            const authConfig = site.authConfig as any
            const privy = new PrivyClient(
              authConfig.privyAppId,
              authConfig.privyAppSecret,
            )

            try {
              const t0 = Date.now()
              await privy.verifyAuthToken(token)
              const t1 = Date.now()
              console.log('t1-t0=======>', t1 - t0)
              const user = await createUserByAddress(address)
              const t2 = Date.now()
              console.log('t2-t1=======>', t2 - t1)
              // console.log('=====user:', user)
              updateSubscriptions(address as Address)
              return user
            } catch (error) {
              console.log('====authorize=error:', error)
              return null
            }
          } catch (e) {
            return null
          }
        },
      }),

      credentialsProvider({
        id: 'plantree-google',
        name: 'Plantree',
        credentials: {
          email: {
            label: 'Email',
            type: 'text',
            placeholder: '',
          },
          openid: {
            label: 'OpenID',
            type: 'text',
            placeholder: '',
          },
          picture: {
            label: 'Picture',
            type: 'text',
            placeholder: '',
          },
          name: {
            label: 'Picture',
            type: 'text',
            placeholder: '',
          },
        },
        async authorize(credentials) {
          try {
            if (!credentials?.email || !credentials?.openid) {
              throw new Error('Login fail')
            }

            const user = await createUserByGoogleInfo(credentials)
            return user
          } catch (e) {
            return null
          }
        },
      }),
    ],
    // pages: {
    //   signIn: `/login`,
    //   verifyRequest: `/login`,
    //   error: '/login', // Error code passed in query string as ?error=
    // },
    session: { strategy: 'jwt' },
    callbacks: {
      async jwt({ token, account, user, profile, trigger, session }) {
        if (user) {
          const sessionUser = user as User & { chainId: string }
          token.uid = sessionUser.id
          token.address = sessionUser.address as string
          token.chainId = sessionUser.chainId
          token.ensName = sessionUser.ensName as string
          token.name = sessionUser.name as string
          token.role = sessionUser.role as string

          token.subscriptions = Array.isArray(sessionUser.subscriptions)
            ? sessionUser.subscriptions.map((i: any) => ({
                planId: i.planId,
                startTime: i.startTime,
                duration: i.duration,
              }))
            : []
        }
        if (trigger === 'update') {
          const subscriptions = await updateSubscriptions(
            session.address as any,
          )

          token.subscriptions = Array.isArray(subscriptions)
            ? subscriptions.map((i: any) => ({
                planId: i.planId,
                startTime: Number(i.startTime),
                duration: Number(i.duration),
              }))
            : []
        }

        // console.log('jwt token========:', token)

        return token
      },
      session({ session, token, user, trigger, newSession }) {
        session.userId = token.uid as string
        session.address = token.address as string
        session.name = token.name as string
        session.chainId = token.chainId as string
        session.ensName = token.ensName as string
        session.role = token.role as string
        session.subscriptions = token.subscriptions as any

        return session
      },
    },
  })
}

async function createUserByAddress(address: any) {
  let user = await prisma.user.findUnique({ where: { address } })
  if (!user) {
    const count = await prisma.user.count()
    const role = count === 0 ? UserRole.ADMIN : UserRole.READER

    user = await prisma.user.create({
      data: { address, role },
    })
  }

  return user
}

async function createUserByGoogleInfo(info: GoogleLoginInfo) {
  let user = await prisma.user.findUnique({ where: { openid: info.openid } })
  if (!user) {
    const count = await prisma.user.count()
    const role = count === 0 ? UserRole.ADMIN : UserRole.READER

    user = await prisma.user.create({
      data: {
        role,
        name: info.name,
        email: info.email,
        openid: info.openid,
        image: info.picture,
      },
    })
  }

  return user
}

async function updateSubscriptions(address: Address) {
  const site = await prisma.site.findFirst()
  if (!site?.spaceId) return []
  try {
    const publicClient = createPublicClient({
      chain: getChain(),
      transport: http(),
    })
    const subscription = await publicClient.readContract({
      abi: spaceAbi,
      address: site?.spaceId as Address,
      functionName: 'getSubscription',
      args: [0, address],
    })

    await prisma.user.update({
      where: { address },
      data: {
        subscriptions: [
          {
            ...subscription,
            startTime: Number(subscription.startTime),
            duration: Number(subscription.duration),
            amount: subscription.amount.toString(),
          },
        ],
      },
    })
    return [subscription]
  } catch (error) {
    console.log('====== updateSubscriptions=error:', error)
    return []
  }
}

let secret = ''

async function getAuthSecret() {
  let nextAuthSecret = process.env.NEXTAUTH_SECRET
  if (nextAuthSecret) return nextAuthSecret
  if (secret) return secret

  const site = await prisma.site.findFirst({
    select: {
      authSecret: true,
    },
  })
  secret = site?.authSecret || ''
  return site?.authSecret || ''
}
