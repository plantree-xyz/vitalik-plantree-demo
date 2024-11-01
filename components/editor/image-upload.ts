import { calculateSHA256FromFile } from '@/lib/calculateSHA256FromFile'
import { IPFS_UPLOAD_URL } from '@/lib/constants'
import { uploadToGoogleDrive } from '@/lib/uploadToGoogleDrive'
import { StorageProvider } from '@prisma/client'
import { createImageUpload } from 'novel/plugins'
import { toast } from 'sonner'

const onUpload = async (file: File) => {
  const fileHash = await calculateSHA256FromFile(file)
  const site = (window as any).__SITE__

  let promise: Promise<Response>

  if (site.storageProvider === StorageProvider.VERCEL_BLOB) {
    promise = fetch(`/api/upload?fileHash=${fileHash}`, {
      method: 'POST',
      headers: {
        'content-type': file?.type || 'application/octet-stream',
        'x-vercel-filename': file?.name || 'image.png',
      },
      body: file,
    })
  } else {
    promise = fetch(IPFS_UPLOAD_URL, {
      method: 'POST',
      body: file,
    })
  }

  return new Promise((resolve) => {
    toast.promise(
      promise.then(async (res) => {
        // Successfully uploaded image
        if (res.status === 200) {
          const { url } = (await res.json()) as any
          // preload the image
          let image = new Image()
          image.src = url
          image.onload = () => {
            resolve(url)
          }

          uploadToGoogleDrive(fileHash, file)
          // No blob store configured
        } else if (res.status === 401) {
          resolve(file)
          throw new Error(
            '`BLOB_READ_WRITE_TOKEN` environment variable not found, reading image locally instead.',
          )
          // Unknown error
        } else {
          throw new Error(`Error uploading image. Please try again.`)
        }
      }),
      {
        loading: 'Uploading image...',
        success: 'Image uploaded successfully.',
        error: (e) => e.message,
      },
    )
  })
}

export const uploadFn = createImageUpload({
  onUpload,
  validateFn: (file) => {
    if (!file.type.includes('image/')) {
      toast.error('File type not supported.')
      return false
    } else if (file.size / 1024 / 1024 > 20) {
      toast.error('File size too big (max 20MB).')
      return false
    }
    return true
  },
})
