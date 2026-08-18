import { Composition } from 'remotion'
import { Main, DURATION, FPS } from './Main'

export const Root: React.FC = () => {
  return (
    <Composition
      id="OrchaIntro"
      component={Main}
      durationInFrames={DURATION}
      fps={FPS}
      width={1920}
      height={1080}
    />
  )
}
