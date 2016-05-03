var bpm = 120;
var volume;
var playIndex;
var startTime;
var loop_length = 16;
var lastDrawTime = -1;
console.log(loop_length);
var kick;
var snare;
var hat;

var context;
var bufferLoader;

var recorder = new SC.Recorder();

if (window.hasOwnProperty('AudioContext') && !window.hasOwnProperty('webkitAudioContext')) {
  window.webkitAudioContext = AudioContext;
}

$(document).ready(function() {
  $('#samplesLoading').show();
  $('#container').hide();
  init();
  playPauseListener();
  stopListener();
  console.log("context.currentTime" + context.currentTime);
})

function init() {
  //Load your samples
  context = new webkitAudioContext();
  // context = new AudioContext();
  // console.log("context.currentTime" + context.currentTime);
  bufferLoader = new BufferLoader(
    context,
    [
      '../kick.wav',
      '../snare.wav',
      '../closedhat.wav'
    ],
    finishedLoading
    );
  bufferLoader.load();
}

function finishedLoading(bufferList) {
  kickBuffer = bufferList[0];
  snareBuffer = bufferList[1];
  hatBuffer = bufferList[2];

  $('#samplesLoading').hide();
  $('#container').show();
}

function playSound(sourceBuffer) {
  // console.log(sourceBuffer);
  // console.log("currentTime:" + context.currentTime);
  var source = context.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(context.destination);
  source.start(0);
}

$('#tempoControl').click(function() {
  // console.log("currentTime:" + context.currentTime);
  playSound(snareBuffer);
});

$('#soundcloudRecordStart').click(function(){
  console.log('I started recording');
  recorder.start();
});
$('#soundcloudRecordStop').click(function(){
  console.log('I stopped recording');
  recorder.stop();
  console.log(recorder.getWAV());
  
  recorder.play();
  recorder.saveAs(filename)
});
///////////////////////////////////////////////////////////// FROM CATARAK
function playPauseListener() {
  $('#play-pause').click(function() {
    // console.log('greetings');
    // var $span = $(this).children("span");
    // if($span.hasClass('glyphicon-play')) {
    //   $span.removeClass('glyphicon-play');
    //   $span.addClass('glyphicon-pause');
      startPlay();
    // }
    // else {
    //   $span.addClass('glyphicon-play');
    //   $span.removeClass('glyphicon-pause');
    //   handleStop();
    // }

  });
}

function stopListener(){
  $('#stop').click(function(){

  })
}

function startPlay(event) {
    console.log('Handle Play');
    playIndex = 0;
    noteTime = 0.0;
    startTime = context.currentTime + 0.005;
    schedule();
}

function handleStop(event) {
  console.log('I stopped');
  cancelAnimationFrame(timeoutId);
  $(".pad").removeClass("playing");
}
/////////////////////////////////////////////////////////////

function schedule() {
  var currentTime = context.currentTime;
  currentTime -= startTime;
  while (noteTime < currentTime + 0.200) {
      var contextPlayTime = noteTime + startTime;
      var $currentCells = $(".column_" + playIndex);
      $currentCells.each(function() {
        if ($(this).hasClass("active") && $(this).hasClass("kick")) {
            playSound(kickBuffer);
          }
        if ($(this).hasClass("active") && $(this).hasClass("snare")) {
            playSound(snareBuffer);
          }
        if ($(this).hasClass("active") && $(this).hasClass("hat")) {
            playSound(hatBuffer);
          }

      })
    if (noteTime != lastDrawTime) {
        lastDrawTime = noteTime;
        drawPlayhead(playIndex);
    }
    advanceNote();
  }
  timeoutId = requestAnimationFrame(schedule)
}

function drawPlayhead(xindex) {
    var lastIndex = (xindex + loop_length - 1) % loop_length;

    //can change this to class selector to select a column
    var $newRows = $('.column_' + xindex);
    var $oldRows = $('.column_' + lastIndex);

    $newRows.addClass("playing");
    $oldRows.removeClass("playing");
}

function advanceNote() {
    // Advance time by a 16th note...
    // var secondsPerBeat = 60.0 / theBeat.tempo;
    //TODO CHANGE TEMPO HERE, convert to float
    // tempo = Number($("#tempo-input").val());
    var secondsPerBeat = 60.0 / bpm;
    playIndex++;
    if (playIndex == loop_length) {
        playIndex = 0;
    }

    //0.25 because each square is a 16th note
    noteTime += 0.25 * secondsPerBeat
}

// };
// var oscillator = context.createOscillator();
// oscillator.connect(context.destination);
// const gain = context.createGain();              // CREATE GAIN NODE
// oscillator.connect(gain);
// gain.connect(context.destination);              // CONNECT GAIN NODE TO DESTINATION
// oscillator.start(0);
// oscillator.stop(context.currentTime + 2);

// VOLUME SLIDER
document.getElementById('volume-slider').addEventListener('change', function(){
  gain.gain.value = parseFloat(this.value);
  console.log(gain.gain.value);
})

// ADD EVENT LISTENERS TO ACTIVATE/DEACTIVATE CELLS
var cells = document.getElementsByClassName('cell');

for (var i = 0; i < cells.length; i++) {
  cells[i].addEventListener('click', function(event){
  console.log(event.target);
    if(this.classList.contains('active')){
      this.classList.remove('active');
    } else {
      this.classList.add('active')
    }
  })
};


////////////////////////////////////////////////////////////////////////////////
////////////      SOUNDCLOUD RECORDER       ////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
var recorder = new SC.Recorder();
// recorder.start();

// setTimeout(function(){
//   recorder.stop();
//   recorder.play();
// }, 5000);
