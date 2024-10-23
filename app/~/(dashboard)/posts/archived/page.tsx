'use client'

import { PostList } from '@/app/~/PostList'
import { PostStatus } from '@/lib/constants'

export const dynamic = 'force-static'

export default function Page() {
  return <PostList status={PostStatus.ARCHIVED} />
}
