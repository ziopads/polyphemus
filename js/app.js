var bpm = 120;
var volume;
var playIndex;
var playIndexKick;
var playIndexSnare;
var startTime;
var lookaheadTime = 0.200;
var loop_length = 16;
var loop_lengthKick = 16;
var loop_lengthSnare = 16;
// var lastDrawTime = -1;
var noteTime;
// console.log(loop_length);
var kick;
var snare;
var hat;
var rec;
var gain;

var SCConnected = false;

// const gain = context.createGain();              // CREATE GAIN NODE
// oscillator.connect(gain);
// gain.connect(context.destination);

var context;
var bufferLoader;

var instruments = ['lead','bass','closedhat','snare','kick']
var currentState = {};

////////////////////////////////////////////////////////////////////////////////
////////////      DOCUMENT READY       /////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
$(document).ready(function() {
  $('#samplesLoading').show();
  $('#container').hide();
  init();
  playStopListener();
  // stopListener();
  console.log("context.currentTime" + context.currentTime);
  var recorderObj = {
      context: context,
      source: gain
  };
  recorder = new SC.Recorder(recorderObj);
  upload = new SC.upload();
})

function init() {
  // if (window.hasOwnProperty('AudioContext') && !window.hasOwnProperty('webkitAudioContext')) {
  //   window.webkitAudioContext = AudioContext;
  // }
  context = new webkitAudioContext();
  // context = new AudioContext();
  context.number
  gain = context.createGain();
  gain.connect(context.destination);
  bufferLoader = new BufferLoader(
    context,
    [
      '../samples/kick.wav',
      '../samples/snare.wav',
      '../samples/closedhat.wav',
      '../samples/lead.wav',
      '../samples/bass.wav'
    ],
    finishedLoading
    );
  bufferLoader.load();
}

function finishedLoading(bufferList) {
  kickBuffer = bufferList[0];
  snareBuffer = bufferList[1];
  hatBuffer = bufferList[2];
  leadBuffer = bufferList[3];
  bassBuffer = bufferList[4];
  $('#samplesLoading').hide();
  $('#container').show();
}

////////////////////////////////////////////////////////////////////////////////
////////////      PLAY/STOP       //////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
// function playSound(sourceBuffer) {
//   var source = context.createBufferSource();
//   source.buffer = sourceBuffer;
//   source.connect(context.destination);
//   source.start(0);
// }

function playSound(sourceBuffer) {
  var source = context.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(gain);
  source.start(0);
}

function playStopListener() {
  $('.playStop').click(function(e) {
    if ($(e.target).hasClass('fa-play')) {
      startPlay();
    } else {
      stopPlay();
    }
    $(e.target).toggleClass('fa-play fa-stop');
  });
}

function startPlay() {
  playIndexMaster = 0;
  playIndexKick = 0;
  playIndexSnare = 0;
  noteTime = 0.0;
  startTime = context.currentTime + lookaheadTime; // actually, this probably isn't lookaheadTime so much as it is a temporal offset applied on playstart to allow for JS stuff. This is the value that was creating a problem in timing when hitting play. Latency setting.
  schedule();
}

function stopPlay() {
  cancelAnimationFrame(timeoutId);
  $(".cell").removeClass("playing");
}

function schedule() {
  var currentTime = context.currentTime;  // currentTime is the time SINCE hitting play and starting the sequencer
  currentTime -= startTime;
  while (noteTime < currentTime + lookaheadTime) {
    var $currentKick = $(".kick.column_" + playIndexKick) + $(".snare.column_" + playIndexSnare);
    console.log($currentCells);
    $currentCells.each(function() {
      if ($(this).hasClass("active") && $(this).hasClass("kick")) {
        playSound(kickBuffer);
      }
      if ($(this).hasClass("active") && $(this).hasClass("snare")) {
        playSound(snareBuffer);
      }
      // if ($(this).hasClass("active") && $(this).hasClass("hat")) {
      //   playSound(hatBuffer);
      // }
      // if ($(this).hasClass("active") && $(this).hasClass("lead")) {
      //   playSound(leadBuffer);
      // }
      // if ($(this).hasClass("active") && $(this).hasClass("bass")) {
      //   playSound(bassBuffer);
      // }
    })
    // if (noteTime != lastDrawTime) {
    //     lastDrawTime = noteTime;
    // drawPlayhead(playIndex);
    drawPlayheadKick(playIndexKick);
    // drawPlayheadSnare(playIndexSnare);
    // }
    advanceNote();
  }
  timeoutId = requestAnimationFrame(schedule);
}

// function drawPlayhead(currentIndex) {
//     var previousIndex = (currentIndex + loop_length - 1) % loop_length;
//     var $newRows = $('.column_' + currentIndex);
//     var $oldRows = $('.column_' + previousIndex);
//
//     $newRows.addClass("playing");
//     $oldRows.removeClass("playing");
// }

function drawPlayheadKick(currentIndex) {
    var previousIndex = (currentIndex + loop_lengthKick - 1) % loop_lengthKick;
    var $newRowsKick = $('.kick.column_' + currentIndex);
    var $oldRowsKick = $('.kick.column_' + previousIndex);

    $newRowsKick.addClass("playing");
    $oldRowsKick.removeClass("playing");
}
function drawPlayheadSnare(currentIndex) {
    var previousIndex = (currentIndex + loop_lengthSnare - 1) % loop_lengthSnare;
    var $newRowsSnare = $('.snare.column_' + currentIndex);
    var $oldRowsSnare = $('.snare.column_' + previousIndex);

    $newRowsSnare.addClass("playing");
    $oldRowsSnare.removeClass("playing");
}

function advanceNote() {
    var secondsPerBeat = 240.0 / bpm;
    playIndexMaster++;
    playIndexKick++;
    playIndexSnare++;
    if (playIndexMaster == loop_length) {  // when playIndex reaches the end of the loop,
        playIndexMaster = 0;               // return to index 0
    }
    if (playIndexKick == loop_lengthKick) {  // when playIndex reaches the end of the loop,
        playIndexKick = 0;               // return to index 0
    }
    if (playIndexSnare == loop_lengthSnare) {  // when playIndex reaches the end of the loop,
        playIndexSnare = 0;               // return to index 0
    }
    //0.25 because each square is a 16th note
    noteTime += 0.25 * secondsPerBeat
    // console.log(playIndexSnare);
}

////////////////////////////////////////////////////////////////////////////////
////////////      TODO CODE FOR SETTING LOOP_LENGTH       //////////////////////
////////////////////////////////////////////////////////////////////////////////
$('#kickLength').change(function(e){
  loop_lengthKick = $(this).val();
  // console.log(loop_lengthKick);
})
$('#snareLength').change(function(e){
  loop_lengthSnare = $(this).val();
  console.log('SNARE ', loop_lengthSnare);
})

////////////////////////////////////////////////////////////////////////////////
////////////      VOLUME SLIDER       //////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
// document.getElementById('volume-slider').addEventListener('change', function(){
//   gain.gain.value = parseFloat(this.value);
//   console.log(gain.gain.value);
// })
////////////////////////////////////////////////////////////////////////////////
////////////      EVENT LISTENERS TO ACTIVATE/DEACTIVATE CELLS       ///////////
////////////////////////////////////////////////////////////////////////////////
function reset(){
  $('.cell').removeClass('active');
}

$('#reset').click(function(){
  reset();
});

var cells = document.getElementsByClassName('cell');

for (var i = 0; i < cells.length; i++) {
  cells[i].addEventListener('click', function(event){
  // console.log(event.target);
    if(this.classList.contains('active')){
      this.classList.remove('active');
    } else {
      this.classList.add('active')
    }
  })
};
