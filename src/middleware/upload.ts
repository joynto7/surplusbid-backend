import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../config/cloudinary';

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'surplusbid', resource_type: 'auto' } as never,
});

export const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
