import { Router, type Response } from 'express'
import type { ExternalApiRouteContribution } from '../../../server/core/external-api-contributions'
import {
  attachMediaWorkGroupItem,
  detachMediaWorkGroupItem,
  mergeMediaWorkGroups,
  setManualMediaCatalog,
  setMediaCatalogTitle,
  setMediaWorkGroupTitle,
  splitMediaWorkGroup,
} from './media-catalog'

export const mediaCatalogExternalApiRoutes: ExternalApiRouteContribution = {
  moduleId: 'media-catalog',
  createRouter({ db, auth, input, errors, responses, cache }) {
    const router = Router()
    const { withRole } = auth
    const { assertKeys, limitedString, plainBody, positiveInteger } = input
    const fail = (message: string, status: number, code: string): never => {
      throw errors.create(message, status, code)
    }
    const reply = (res: Response, catalog: Parameters<typeof responses.catalog>[0]) => {
      cache.invalidateLibraryMatches()
      res.json(responses.catalog(catalog))
    }

    router.put('/folders/:id/media-catalog', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['kind', 'seasonNumbers', 'partNumber', 'customLabel', 'clearManual', 'excluded'])
      reply(res, setManualMediaCatalog(db, positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'), body))
    }))

    router.put('/folders/:id/media-catalog-title', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['title'])
      reply(res, setMediaCatalogTitle(
        db,
        positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'),
        limitedString(body.title, 'title', 500) as string,
      ))
    }))

    router.put('/folders/:id/media-work-groups/:groupId/title', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['title'])
      reply(res, setMediaWorkGroupTitle(
        db,
        positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'),
        positiveInteger(req.params.groupId, 'work group id', 'INVALID_MEDIA_WORK_GROUP_ID'),
        limitedString(body.title, 'title', 500) as string,
      ))
    }))

    router.post('/folders/:id/media-work-groups/:targetGroupId/merge', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['sourceGroupId'])
      reply(res, mergeMediaWorkGroups(
        db,
        positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'),
        positiveInteger(req.params.targetGroupId, 'target work group id', 'INVALID_MEDIA_WORK_GROUP_ID'),
        positiveInteger(body.sourceGroupId, 'sourceGroupId', 'INVALID_MEDIA_WORK_GROUP_ID'),
      ))
    }))

    router.post('/folders/:id/media-work-groups/:groupId/detach', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['mediaItemId', 'title'])
      reply(res, detachMediaWorkGroupItem(
        db,
        positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'),
        positiveInteger(req.params.groupId, 'work group id', 'INVALID_MEDIA_WORK_GROUP_ID'),
        positiveInteger(body.mediaItemId, 'mediaItemId', 'INVALID_MEDIA_ITEM_ID'),
        body.title === undefined ? undefined : limitedString(body.title, 'title', 500) as string,
      ))
    }))

    router.post('/folders/:id/media-work-groups/:groupId/attach', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['mediaItemId'])
      reply(res, attachMediaWorkGroupItem(
        db,
        positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'),
        positiveInteger(req.params.groupId, 'work group id', 'INVALID_MEDIA_WORK_GROUP_ID'),
        positiveInteger(body.mediaItemId, 'mediaItemId', 'INVALID_MEDIA_ITEM_ID'),
      ))
    }))

    router.post('/folders/:id/media-work-groups/:groupId/split', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['mediaItemIds', 'title'])
      if (!Array.isArray(body.mediaItemIds)) return fail('mediaItemIds must be an array', 400, 'INVALID_MEDIA_ITEM_IDS')
      const mediaItemIds = body.mediaItemIds.map(value => positiveInteger(value, 'media item id', 'INVALID_MEDIA_ITEM_IDS'))
      reply(res, splitMediaWorkGroup(
        db,
        positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'),
        positiveInteger(req.params.groupId, 'work group id', 'INVALID_MEDIA_WORK_GROUP_ID'),
        mediaItemIds,
        limitedString(body.title, 'title', 500) as string,
      ))
    }))

    return router
  },
}
