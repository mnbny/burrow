import footerTemplate from './footer.html'

export const footer = process.env.HIDE_FOOTER === '1' ? '' : footerTemplate
